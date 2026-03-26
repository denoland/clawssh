const target = process.env.CLAWSSH_TARGET;
const remoteCwd = process.env.CLAWSSH_REMOTE_CWD;
const sshOptsJson = process.env.CLAWSSH_SSH_OPTS;

if (!target || !remoteCwd || !sshOptsJson) return;

const SSH_OPTS = JSON.parse(sshOptsJson);
const SSH_BASE_ARGS = [...SSH_OPTS, target, '--'];
const MAX_BUFFER = 50 * 1024 * 1024;
const SSH_TIMEOUT = 30_000;
const EVAL_CMD_RE = /eval\s+'((?:[^'\\]|'\\'')*?)'\s*\\?/;
const CTRL_CHAR_RE = /[\x00-\x1f\x7f]/;

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const debug = !!process.env.CLAWSSH_DEBUG;

function sq(s) {
  s = String(s).replace(/\0/g, '');
  if (!s.includes("'")) return "'" + s + "'";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function log(tag, msg) {
  if (debug) process.stderr.write(`\x1b[33m[clawssh:${tag}] ${msg}\x1b[0m\n`);
}

function enoent(syscall, p) {
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`);
  err.code = 'ENOENT'; err.errno = -2; err.syscall = syscall; err.path = p;
  return err;
}

function validatePath(p) {
  if (CTRL_CHAR_RE.test(p)) throw new Error(`clawssh: path contains control characters: ${JSON.stringify(p)}`);
}

function isRemote(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return p === remoteCwd || p.startsWith(remoteCwd + '/');
  return true;
}

function resolvePath(p) {
  if (path.isAbsolute(p)) return p;
  return path.posix.join(remoteCwd, p);
}

function isTransient(err) {
  const msg = String(err.message || err.stderr || '');
  return msg.includes('Connection reset') || msg.includes('Broken pipe') ||
         msg.includes('Connection closed') || err.killed;
}

function ssh(command) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return childProcess.execFileSync('ssh', [...SSH_BASE_ARGS, command], {
        maxBuffer: MAX_BUFFER, timeout: SSH_TIMEOUT,
      });
    } catch (err) {
      if (attempt === 0 && isTransient(err)) { log('ssh', 'retrying...'); continue; }
      throw err;
    }
  }
}

function sshRead(p, encoding) {
  validatePath(p); p = resolvePath(p);
  const buf = ssh(`cat ${sq(p)}`);
  return encoding ? buf.toString(encoding) : buf;
}

function sshWrite(p, data) {
  validatePath(p); p = resolvePath(p);
  const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return childProcess.execFileSync('ssh', [...SSH_BASE_ARGS, `cat > ${sq(p)}`], {
        input: content, maxBuffer: MAX_BUFFER, timeout: SSH_TIMEOUT,
      });
    } catch (err) {
      if (attempt === 0 && isTransient(err)) continue;
      throw err;
    }
  }
}

function sshStat(p) {
  validatePath(p); p = resolvePath(p);
  try {
    const out = ssh(
      `stat -c '%s %Y %F' ${sq(p)} 2>/dev/null || stat -f '%z %m %HT' ${sq(p)}`
    ).toString().trim();
    const parts = out.split(/\s+/);
    const size = parseInt(parts[0], 10) || 0;
    const mtimeS = parseInt(parts[1], 10) || Math.floor(Date.now() / 1000);
    const typeStr = parts.slice(2).join(' ').toLowerCase();
    const isDir = typeStr.includes('directory');
    return {
      size, mode: isDir ? 0o40755 : 0o100644, mtimeMs: mtimeS * 1000,
      isFile: () => !isDir, isDirectory: () => isDir,
      isSymbolicLink: () => false, isBlockDevice: () => false,
      isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    };
  } catch { throw enoent('stat', p); }
}

function sshExists(p) {
  validatePath(p); p = resolvePath(p);
  try { ssh(`test -e ${sq(p)}`); return true; } catch { return false; }
}

function sshReaddir(p, options) {
  validatePath(p); p = resolvePath(p);
  try {
    const out = ssh(`ls -1a ${sq(p)}`).toString().trim();
    const entries = out ? out.split('\n').filter(e => e !== '.' && e !== '..') : [];
    if (!options?.withFileTypes) return entries;
    const typeCmd = entries.map(e => `test -d ${sq(p + '/' + e)} && echo d || echo f`).join(';');
    const types = typeCmd ? ssh(typeCmd).toString().trim().split('\n') : [];
    return entries.map((name, i) => {
      const isDir = types[i] === 'd';
      return {
        name, isFile: () => !isDir, isDirectory: () => isDir,
        isSymbolicLink: () => false, isBlockDevice: () => false,
        isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
      };
    });
  } catch { return []; }
}

function sshRealpath(p) {
  validatePath(p); p = resolvePath(p);
  try { return ssh(`realpath ${sq(p)}`).toString().trim(); }
  catch { return p; }
}

const HANDLERS = {
  readFile: (p, opts) => {
    const enc = typeof opts === 'string' ? opts : opts?.encoding;
    try { return sshRead(p, enc); }
    catch { throw enoent('open', p); }
  },
  writeFile: (p, data) => sshWrite(p, data),
  stat: (p) => sshStat(p),
  lstat: (p) => sshStat(p),
  readdir: (p, opts) => sshReaddir(p, opts),
  mkdir: (p, opts) => {
    validatePath(p);
    try { ssh(`mkdir ${opts?.recursive ? '-p ' : ''}${sq(resolvePath(p))}`); } catch {}
  },
  access: (p) => { if (!sshExists(p)) throw enoent('access', p); },
  realpath: (p) => sshRealpath(p),
  unlink: (p) => { validatePath(p); ssh(`rm -f ${sq(resolvePath(p))}`); },
  rm: (p, opts) => { validatePath(p); ssh(`rm ${opts?.recursive ? '-rf' : '-f'} ${sq(resolvePath(p))}`); },
};

for (const [base, handler] of Object.entries(HANDLERS)) {
  const syncName = base + 'Sync';
  const original = fs[syncName];
  if (!original) continue;
  const patched = function(p, ...rest) {
    if (isRemote(p)) { log('fs', `${syncName} ${p}`); return handler(p, ...rest); }
    return original.call(this, p, ...rest);
  };
  Object.defineProperty(fs, syncName, { get() { return patched; }, set() {}, configurable: true });
}

if (fs.realpathSync?.native) {
  const orig = fs.realpathSync.native;
  fs.realpathSync.native = function(p, opts) {
    if (isRemote(p)) return sshRealpath(p);
    return orig.call(this, p, opts);
  };
}

for (const [name, handler] of Object.entries(HANDLERS)) {
  const original = fs[name];
  if (!original) continue;
  fs[name] = function(p, ...rest) {
    if (!isRemote(p)) return original.call(this, p, ...rest);
    log('fs', `${name} ${p}`);
    const cb = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    try {
      const result = handler(p, ...rest);
      if (cb) process.nextTick(() => cb(null, result));
    } catch (err) {
      if (cb) process.nextTick(() => cb(err));
      else throw err;
    }
  };
}

const fsp = fs.promises;
for (const [name, handler] of Object.entries(HANDLERS)) {
  const original = fsp[name];
  if (!original) continue;
  fsp[name] = async function(p, ...rest) {
    if (isRemote(p)) { log('fsp', `${name} ${p}`); return handler(p, ...rest); }
    return original.call(this, p, ...rest);
  };
}

const REMOTE_PREFIX = `cd ${sq(remoteCwd)} && `;

function wrap(cmd) {
  return { command: 'ssh', args: [...SSH_BASE_ARGS, 'bash', '--norc', '--noprofile', '-c', sq(REMOTE_PREFIX + cmd)] };
}

function route(command, spawnArgs) {
  const cmd = path.basename(String(command));

  if ((cmd === 'bash' || cmd === 'zsh' || cmd === 'sh') &&
      Array.isArray(spawnArgs) && spawnArgs.includes('-c')) {
    const shellCmd = spawnArgs[spawnArgs.indexOf('-c') + 1];
    if (typeof shellCmd === 'string') {
      const m = shellCmd.match(EVAL_CMD_RE);
      if (m) {
        const actual = m[1].replace(/'\\'''/g, "'");
        log('tool', actual.slice(0, 100));
        return wrap(actual);
      }
    }
    return null;
  }

  return null;
}

const origSpawn = childProcess.spawn;

function patched(command, spawnArgs, options) {
  const remote = route(command, spawnArgs);
  if (remote) {
    const child = origSpawn.call(this, remote.command, remote.args, options);
    let killed = null;
    const _kill = child.kill.bind(child);
    child.kill = function(sig) { killed = sig || 'SIGTERM'; return _kill(sig); };
    const _on = child.on.bind(child);
    child.on = function(ev, fn) {
      if (ev === 'exit') return _on(ev, (code, sig) => fn(killed && !sig ? null : code, killed || sig));
      return _on(ev, fn);
    };
    return child;
  }
  return origSpawn.call(this, command, spawnArgs, options);
}

Object.keys(origSpawn).forEach(k => {
  Object.defineProperty(patched, k, { value: origSpawn[k], writable: true, configurable: true });
});
Object.defineProperty(childProcess, 'spawn', { get() { return patched; }, set() {}, configurable: true });

const origSpawnSync = childProcess.spawnSync;
function patchedSync(command, spawnArgs, options) {
  const remote = route(command, spawnArgs);
  if (remote) return origSpawnSync.call(this, remote.command, remote.args, options);
  return origSpawnSync.call(this, command, spawnArgs, options);
}
Object.defineProperty(childProcess, 'spawnSync', { get() { return patchedSync; }, set() {}, configurable: true });
