"""Serve the project locally, including compressed assets and seekable video."""
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        self.range_length = None
        original = Path(self.translate_path(self.path))
        if not original.is_file():
            return super().send_head()
        if original.suffix == '.mp4' and self.headers.get('Range'):
            return self.video_range(original)
        compressed = Path(str(original) + '.gz')
        if (original.suffix in {'.js', '.css', '.json', '.html'}
                and 'gzip' in self.headers.get('Accept-Encoding', '')
                and compressed.is_file() and compressed.stat().st_mtime >= original.stat().st_mtime):
            stream = compressed.open('rb')
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(original)))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Length', str(compressed.stat().st_size))
            self.end_headers()
            return stream
        return super().send_head()

    def video_range(self, path):
        info = path.stat()
        modified = self.date_time_string(info.st_mtime)
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers['Range'].strip())
        if not match or not any(match.groups()) or self.headers.get('If-Range', modified) != modified:
            return super().send_head()
        first, last = match.groups()
        size = info.st_size
        start = int(first) if first else max(0, size - int(last))
        end = min(int(last), size - 1) if first and last else size - 1
        if start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        stream = path.open('rb')
        stream.seek(start)
        self.range_length = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Last-Modified', modified)
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self.range_length))
        self.end_headers()
        return stream

    def copyfile(self, source, output):
        try:
            if self.range_length is None:
                return super().copyfile(source, output)
            remaining = self.range_length
            while remaining:
                block = source.read(min(remaining, 64 * 1024))
                if not block:
                    break
                output.write(block)
                remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The browser cancelled a superseded view or video seek.

    def end_headers(self):
        path = urlsplit(self.path).path
        if path.endswith('.mp4'):
            self.send_header('Accept-Ranges', 'bytes')
        cache = 'no-cache' if path.endswith(('.html','.js','.css','.json')) or path == '/' else 'public, max-age=86400'
        self.send_header('Cache-Control', cache)
        super().end_headers()


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8780), Handler).serve_forever()
