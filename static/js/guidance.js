// Display-only cleanup at the guidance atlas's native resolution. Source
// visibility values, fine-structure support and ultrasound images stay intact.
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

export function cleanVisibilityContours(rgba,width,height){
 const visible=new Uint8Array(width*height),edge=new Uint8Array(width*height);
 for(let p=0;p<visible.length;p++)visible[p]=rgba[p*4+2]>127?1:0;
 // Suppress outlines of isolated visibility islands smaller than 0.2% of
 // the 256 x 256 map; do not smooth or move the retained shadow boundaries.
 removeSmallComponents(visible,width,height,128);
 for(let p=0;p<edge.length;p++){
  if(!rgba[p*4+1])continue;
  const x=p%width,y=Math.floor(p/width);
  edge[p]=visible[p]||(x>0&&visible[p-1])||(x<width-1&&visible[p+1])||
   (y>0&&visible[p-width])||(y<height-1&&visible[p+width])?1:0;
 }
 // Fan clipping can leave a few disconnected boundary pixels at the rim.
 removeSmallComponents(edge,width,height,32);
 for(let p=0;p<edge.length;p++)if(!edge[p])rgba[p*4+1]=0;
}
