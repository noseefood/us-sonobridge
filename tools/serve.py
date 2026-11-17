"""Local static preview with precompressed text assets and conditional caching."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
 def send_head(self):
  original=Path(self.translate_path(self.path));compressed=Path(str(original)+'.gz')
  if original.is_file() and original.suffix in ('.js','.css','.json','.html') and 'gzip' in self.headers.get('Accept-Encoding','') and compressed.is_file() and compressed.stat().st_mtime>=original.stat().st_mtime:
   f=compressed.open('rb');self.send_response(200);self.send_header('Content-Type',self.guess_type(str(original)));self.send_header('Content-Encoding','gzip');self.send_header('Vary','Accept-Encoding');self.send_header('Content-Length',str(compressed.stat().st_size));self.end_headers();return f
  return super().send_head()
 def end_headers(self):
  path=urlsplit(self.path).path
  self.send_header('Cache-Control','no-cache' if path.endswith(('.html','.js','.css','.json')) or path=='/' else 'public, max-age=86400')
  super().end_headers()
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8780),Handler).serve_forever()
