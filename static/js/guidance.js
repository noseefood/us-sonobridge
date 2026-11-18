// Display-only shadow outlines from the continuous visibility channel.
// The native masks propagate shadows along 180 curvilinear scanlines. Their
// lateral softening/area edits can fluctuate around 0.5 between depth rows;
// directly thresholding these rows creates horizontal loops. Fit decreasing
// visibility along each ray before locating its boundary instead.
// This never changes source visibility, fine-structure support or US pixels.
const geometryCache=new Map();
function geometry(width,height){
 const key=`${width}:${height}`;
 if(geometryCache.has(key))return geometryCache.get(key);
 // Both shipped models use this native ShadowMaskConfig geometry, including
 // the 180 mm mask depth. The image's separate physical fan clips the overlay.
 const rays=180,depths=height,half=35*Math.PI/180,near=46/226,zmin=near*Math.cos(half),maxx=Math.sin(half);
 const angle0=-half+half/rays,angleStep=2*half/rays,r0=near+2/height,rStep=(1-2/height-r0)/(depths-1);
 const samples=new Int32Array(rays*depths),fx=new Float64Array(samples.length),fy=new Float64Array(samples.length);
 for(let ray=0;ray<rays;ray++){
  const angle=angle0+ray*angleStep;
  for(let d=0;d<depths;d++){
   const r=r0+d*rStep,x=Math.max(0,Math.min(width-1.000001,(r*Math.sin(angle)/maxx+1)*width/2));
   const y=Math.max(0,Math.min(height-1.000001,(r*Math.cos(angle)-zmin)/(1-zmin)*height)),k=ray*depths+d;
   samples[k]=Math.floor(y)*width+Math.floor(x);fx[k]=x-Math.floor(x);fy[k]=y-Math.floor(y);
  }
 }
 const radius=new Float64Array(width*height),angleIndex=new Float64Array(radius.length),valid=new Uint8Array(radius.length),interior=new Uint8Array(radius.length);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const p=y*width+x,px=(x/width*2-1)*maxx,py=y/height*(1-zmin)+zmin,angle=Math.atan2(px,py);
  radius[p]=Math.hypot(px,py);angleIndex[p]=Math.max(0,Math.min(rays-1,(angle-angle0)/angleStep));
  valid[p]=radius[p]>=near&&radius[p]<=1&&Math.abs(angle)<=half?1:0;
 }
 for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
  const p=y*width+x;
  interior[p]=valid[p]&&valid[p-1]&&valid[p+1]&&valid[p-width]&&valid[p+width]&&valid[p-2]&&valid[p+2]&&valid[p-2*width]&&valid[p+2*width]&&valid[p-width-1]&&valid[p-width+1]&&valid[p+width-1]&&valid[p+width+1]?1:0;
 }
 const result={rays,depths,near,r0,rStep,samples,fx,fy,radius,angleIndex,valid,interior};geometryCache.set(key,result);return result;
}

// Pool-adjacent-violators gives the least-squares nonincreasing fit. A ray
// crosses 0.5 at most once, so threshold ripples cannot form stacked bands.
function shadowOnsets(rgba,width,g){
 const starts=new Float64Array(g.rays),means=new Float64Array(g.depths),weights=new Uint16Array(g.depths),fit=new Float64Array(g.depths);
 for(let ray=0;ray<g.rays;ray++){
  let blocks=0;
  for(let d=0;d<g.depths;d++){
   const k=ray*g.depths+d,p=g.samples[k]*4+2,fx=g.fx[k],fy=g.fy[k];
   means[blocks]=(rgba[p]*(1-fx)+rgba[p+4]*fx)*(1-fy)+(rgba[p+width*4]*(1-fx)+rgba[p+(width+1)*4]*fx)*fy;
   weights[blocks++]=1;
   while(blocks>1&&means[blocks-2]<means[blocks-1]){
    const a=blocks-2,b=blocks-1,n=weights[a]+weights[b];means[a]=(means[a]*weights[a]+means[b]*weights[b])/n;weights[a]=n;blocks--;
   }
  }
  let count=0;
  for(let b=0;b<blocks;b++){fit.fill(means[b],count,count+weights[b]);count+=weights[b];}
  let first=0;while(first<g.depths&&fit[first]>=127.5)first++;
  starts[ray]=first===g.depths?1.1:first===0?g.near:g.r0+(first-1+(fit[first-1]-127.5)/(fit[first-1]-fit[first]))*g.rStep;
 }
 // A three-ray median removes single-bin angular aliasing (less than 0.4°).
 const stable=starts.slice();
 for(let ray=1;ray<g.rays-1;ray++){const a=starts[ray-1],b=starts[ray],c=starts[ray+1];stable[ray]=a+b+c-Math.min(a,b,c)-Math.max(a,b,c);}
 return stable;
}
function removeSmallComponents(mask,width,height,minArea){
 const seen=new Uint8Array(mask.length),queue=new Uint32Array(mask.length);
 for(let start=0;start<mask.length;start++){
  if(!mask[start]||seen[start])continue;
  let head=0,tail=1;queue[0]=start;seen[start]=1;
  while(head<tail){
   const p=queue[head++],x=p%width,y=Math.floor(p/width);
   for(let yy=Math.max(0,y-1);yy<=Math.min(height-1,y+1);yy++){
    for(let xx=Math.max(0,x-1);xx<=Math.min(width-1,x+1);xx++){
     const next=yy*width+xx;
     if(mask[next]&&!seen[next]){seen[next]=1;queue[tail++]=next;}
    }
   }
  }
  if(tail<minArea)for(let i=0;i<tail;i++)mask[queue[i]]=0;
 }
}

export function visibilityShadow(rgba,width,height){
 const g=geometry(width,height),starts=shadowOnsets(rgba,width,g),shadow=new Uint8Array(width*height);
 for(let p=0;p<shadow.length;p++){
  const ray=Math.min(g.rays-2,Math.floor(g.angleIndex[p])),t=g.angleIndex[p]-ray;
  shadow[p]=g.valid[p]&&g.radius[p]>=starts[ray]*(1-t)+starts[ray+1]*t?1:0;
 }
 return shadow;
}

export function cleanVisibilityContours(rgba,width,height){
 const shadow=visibilityShadow(rgba,width,height),g=geometry(width,height),edge=new Uint8Array(shadow.length);
 for(let p=0;p<edge.length;p++)if(g.interior[p]){
  const lo=shadow[p]&&shadow[p-1]&&shadow[p+1]&&shadow[p-width]&&shadow[p+width];
  const hi=shadow[p]||shadow[p-1]||shadow[p+1]||shadow[p-width]||shadow[p+width];
  edge[p]=hi!==lo?1:0;
 }
 removeSmallComponents(edge,width,height,32);
 for(let p=0;p<edge.length;p++)rgba[p*4+1]=edge[p]*255;
}
