/** Volatile system input observation. Never records keystrokes, cursor positions or presence. */
export class DesktopIdle {
  private sample?: {seconds:number; observedAt:number; generation:number};
  private generation=0;
  update(seconds:number, observedAt:number, now=Date.now()):void {
    if(!Number.isSafeInteger(seconds)||seconds<0||seconds>31536000||!Number.isFinite(observedAt)||observedAt>now||now-observedAt>30000)throw Error('空闲观察无效');
    if(this.sample && observedAt<=this.sample.observedAt)return;
    if(!this.sample || seconds+2<this.sample.seconds) this.generation++;
    this.sample={seconds,observedAt,generation:this.generation};
  }
  clear():void {this.generation++;this.sample=undefined;}
  snapshot(now=Date.now()):{seconds:number;generation:number}|undefined {
    if(!this.sample || now<this.sample.observedAt || now-this.sample.observedAt>30000)return undefined;
    return {seconds:this.sample.seconds,generation:this.sample.generation};
  }
  eligible(now=Date.now()):boolean {return (this.snapshot(now)?.seconds??0)>=120;}
}
