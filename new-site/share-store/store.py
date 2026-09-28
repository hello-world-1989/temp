#!/usr/bin/env python3
"""end-gfw 加密分享 storage (Debian-1-1).

Holds the ciphertext of shared files for the website Worker. Only the Worker talks to
it (X-Store-Key); Caddy in front terminates TLS for the store hostname.

  PUT    /f/<id>   body = ciphertext; X-Meta-Dh (delete-token hash), X-Meta-Pw (0/1)
  HEAD   /f/<id>   X-Size, X-Uploaded (ms), X-Meta-Dh, X-Meta-Pw
  GET    /f/<id>   the same headers + the ciphertext
  DELETE /f/<id>

Files older than 7 days are refused and deleted; a sweep runs every 10 minutes.
No request logging: the store never sees visitor IPs (only the Worker's) and keeps nothing
about requests.
"""
import hmac
import json
import os
import re
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get('STORE_DIR', '/var/lib/end-gfw-share')
KEY_FILE = os.environ.get('STORE_KEY_FILE', '')  # systemd credential
LISTEN = os.environ.get('STORE_LISTEN', '127.0.0.1:8790')
TTL = 7 * 24 * 3600
MAX_BODY = 50 * 1024 * 1024 + 64 * 1024
MAX_TOTAL = int(os.environ.get('STORE_MAX_TOTAL_GB', '20')) * 1024 ** 3  # all stored files
MIN_FREE = int(os.environ.get('STORE_MIN_FREE_GB', '5')) * 1024 ** 3  # keep for the system
ID_RE = re.compile(r'^/f/([A-Za-z0-9_-]{22})$')
HASH_RE = re.compile(r'^[0-9a-f]{64}$')
lock = threading.Lock()


def read_key():
    path = KEY_FILE or os.path.join(os.environ.get('CREDENTIALS_DIRECTORY', ''), 'store-key')
    with open(path) as f:
        key = f.read().strip()
    if len(key) < 32:
        raise SystemExit('store key too short')
    return key.encode()


KEY = read_key()


def paths(fid):
    return os.path.join(DATA, fid + '.bin'), os.path.join(DATA, fid + '.json')


def load_meta(fid):
    try:
        with open(paths(fid)[1]) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def remove(fid):
    for p in paths(fid):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def expired(meta, now=None):
    return (now or time.time()) - meta.get('uploaded', 0) / 1000 > TTL


def stored_bytes():
    total = 0
    with os.scandir(DATA) as it:
        for e in it:
            if e.name.endswith('.bin') or e.name.endswith('.tmp'):
                total += e.stat().st_size
    return total


def sweep():
    now = time.time()
    removed = 0
    with os.scandir(DATA) as it:
        entries = list(it)
    for e in entries:
        if e.name.endswith('.json'):
            fid = e.name[:-5]
            meta = load_meta(fid)
            if meta is None or expired(meta, now):
                remove(fid)
                removed += 1
        elif e.name.endswith('.tmp') and now - e.stat().st_mtime > 3600:
            os.remove(e.path)  # abandoned upload
        elif e.name.endswith('.bin') and not os.path.exists(e.path[:-4] + '.json') and now - e.stat().st_mtime > 3600:
            os.remove(e.path)  # file without metadata
    return removed


def sweeper():
    while True:
        try:
            sweep()
        except Exception as err:  # keep sweeping
            print('sweep failed:', err, flush=True)
        time.sleep(600)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'store'
    sys_version = ''

    def log_message(self, *args):  # no access log
        pass

    def reply(self, status, body=b'', headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def auth(self):
        given = self.headers.get('X-Store-Key', '').encode()
        if not hmac.compare_digest(given, KEY):
            self.reply(403, {'error': 'forbidden'})
            return None
        m = ID_RE.match(self.path)
        if not m:
            self.reply(404, {'error': 'not found'})
            return None
        return m.group(1)

    def meta_headers(self, meta):
        return {
            'X-Size': str(meta['size']),
            'X-Uploaded': str(meta['uploaded']),
            'X-Meta-Dh': meta.get('dh', ''),
            'X-Meta-Pw': meta.get('pw', '0'),
        }

    def current(self, fid):
        meta = load_meta(fid)
        if meta is None or not os.path.exists(paths(fid)[0]):
            return None
        if expired(meta):
            remove(fid)
            return None
        return meta

    def do_HEAD(self):
        fid = self.auth()
        if not fid:
            return
        meta = self.current(fid)
        if not meta:
            return self.reply(404, {'error': 'not found'})
        self.reply(200, b'', self.meta_headers(meta))

    def do_GET(self):
        fid = self.auth()
        if not fid:
            return
        meta = self.current(fid)
        if not meta:
            return self.reply(404, {'error': 'not found'})
        try:
            f = open(paths(fid)[0], 'rb')
        except FileNotFoundError:
            return self.reply(404, {'error': 'not found'})
        with f:
            size = os.fstat(f.fileno()).st_size
            self.send_response(200)
            for k, v in self.meta_headers(meta).items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.end_headers()
            shutil.copyfileobj(f, self.wfile, 256 * 1024)

    def do_DELETE(self):
        fid = self.auth()
        if not fid:
            return
        remove(fid)
        self.reply(200, {'deleted': True})

    def do_PUT(self):
        fid = self.auth()
        if not fid:
            return
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            return self.reply(411, {'error': 'length required'})
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {'error': 'too large'})
        dh = self.headers.get('X-Meta-Dh', '')
        pw = '1' if self.headers.get('X-Meta-Pw') == '1' else '0'
        if not HASH_RE.match(dh):
            return self.reply(400, {'error': 'bad metadata'})
        with lock:
            if os.path.exists(paths(fid)[1]):
                return self.reply(409, {'error': 'exists'})
            free = shutil.disk_usage(DATA).free
            if stored_bytes() + length > MAX_TOTAL or free - length < MIN_FREE:
                return self.reply(507, {'error': 'storage full'})
            tmp = os.path.join(DATA, fid + '.tmp')
            open(tmp, 'wb').close()  # reserve before releasing the lock
        try:
            left = length
            with open(tmp, 'wb') as out:
                while left:
                    chunk = self.rfile.read(min(left, 256 * 1024))
                    if not chunk:
                        raise ConnectionError('short body')
                    out.write(chunk)
                    left -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            meta = {'size': length, 'uploaded': int(time.time() * 1000), 'dh': dh, 'pw': pw}
            bin_path, meta_path = paths(fid)
            os.replace(tmp, bin_path)
            with open(meta_path + '.part', 'w') as f:
                json.dump(meta, f)
            os.replace(meta_path + '.part', meta_path)
        except Exception:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass
            self.close_connection = True
            return
        self.reply(201, {'size': meta['size'], 'uploaded': meta['uploaded']})


def main():
    os.makedirs(DATA, exist_ok=True)
    os.umask(0o077)
    threading.Thread(target=sweeper, daemon=True).start()
    host, port = LISTEN.rsplit(':', 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    print('share store listening on', LISTEN, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
