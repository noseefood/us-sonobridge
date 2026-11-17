"""Local cold-load comparison: 8 Mbps shared throughput, 80 ms request latency.

Serve /baseline/ from the saved v3 frontend, /candidate/ from the working tree.
The injected DOM diagnostics only measure the test page; production has no
benchmark script, throttling or telemetry endpoint.
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
from threading import Lock
import mimetypes
import time

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / 'refs/demo-build/v3-baseline'
lock = Lock()
next_chunk = 0.0
RATE = 1_000_000
INSTRUMENT = b'''<script>
addEventListener('DOMContentLoaded',()=>{
 const e=document.getElementById('explorer'),s=document.getElementById('scene');
 const m={imageMs:null,controlsMs:null,robotMs:null,sceneMs:null,bytes:0,requests:0};
 const publish=()=>{document.body.dataset.benchmark=JSON.stringify(m)};
 const observer=new MutationObserver(()=>{
  if(m.imageMs===null && e.dataset.pose)m.imageMs=Math.round(performance.now());
  if(m.controlsMs===null && e.dataset.ready)m.controlsMs=Math.round(performance.now());
  if(m.robotMs===null && s.dataset.robotReadyMs)m.robotMs=Number(s.dataset.robotReadyMs);
  if(m.sceneMs===null && s.dataset.ready)m.sceneMs=Math.round(performance.now());
  publish();
 });observer.observe(e,{attributes:true,subtree:true});
 new PerformanceObserver(list=>{for(const r of list.getEntries()){m.bytes+=r.encodedBodySize;m.requests++;}publish()}).observe({type:'resource',buffered:true});
 publish();
});
</script>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global next_chunk
        path = unquote(urlsplit(self.path).path).strip('/')
        kind, _, relative = path.partition('/')
        if kind not in ('baseline', 'candidate'):
            self.send_error(404); return
        relative = relative or 'index.html'
        if '..' in Path(relative).parts:
            self.send_error(400); return
        file = (BASELINE if kind == 'baseline' else ROOT) / relative
        if kind == 'baseline' and not file.is_file():
            file = ROOT / relative
            if relative.startswith('static/demo/atlases/') and not file.is_file():
                file = ROOT / 'refs/demo-build/atlases' / Path(relative).name
        if not file.is_file():
            self.send_error(404); return
        data = file.read_bytes()
        encoded=False
        compressed=Path(str(file)+'.gz')
        if kind=='candidate' and file.suffix in ('.js','.css','.json') and compressed.is_file() and compressed.stat().st_mtime>=file.stat().st_mtime and 'gzip' in self.headers.get('Accept-Encoding',''):
            data=compressed.read_bytes();encoded=True
        if file.suffix == '.html':
            data = data.replace(b'</head>', INSTRUMENT+b'</head>')
        time.sleep(.08)
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        if encoded:self.send_header('Content-Encoding','gzip')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            for start in range(0,len(data),16384):
                chunk=data[start:start+16384]
                with lock:
                    now=time.monotonic()
                    next_chunk=max(now,next_chunk)+len(chunk)/RATE
                    pause=next_chunk-now
                time.sleep(pause)
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def log_message(self,*args): pass

if __name__=='__main__':
    print('Benchmark: http://127.0.0.1:8781/{baseline,candidate}/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8781),Handler).serve_forever()
