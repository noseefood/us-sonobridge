// Shared cardinal tangents preserve coordinated joint motion and C1 velocity.
export function createJointCurve(rows){
 const count=rows.length;
 const slopes=rows.map((q,i)=>q.map((_,axis)=>i===0?rows[1][axis]-q[axis]:i===count-1?q[axis]-rows[i-1][axis]:(rows[i+1][axis]-rows[i-1][axis])/2));
 return position=>{
  const p=Math.max(0,Math.min(count-1,position)),i=Math.min(count-2,Math.floor(p)),t=p-i,t2=t*t,t3=t2*t;
  return rows[i].map((q,a)=>(2*t3-3*t2+1)*q+(t3-2*t2+t)*slopes[i][a]+(-2*t3+3*t2)*rows[i+1][a]+(t3-t2)*slopes[i+1][a]);
 };
}
// Ease only at the two ends of the entire sweep, never at individual views.
export function sweepPhase(position,last,direction=1){const a=Math.acos(1-2*Math.max(0,Math.min(last,position))/last);return direction<0?2*Math.PI-a:a;}
export function sweepPosition(elapsed,phase,last,period=16000){return last*(1-Math.cos(phase+elapsed*2*Math.PI/period))/2;}
