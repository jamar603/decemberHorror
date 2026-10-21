// Connexion WebSocket avec reconnexion silencieuse (redémarrage serveur pendant un déploiement = invisible).
import { B_POS, B_SNAP, POS_BYTES, SNAP_ENTRY, type ClientMsg, type ServerMsg } from '../shared/protocol';

export interface Snap { id: number; x: number; y: number; z: number; yaw: number }

export class Net {
  ws: WebSocket | null = null;
  id = 0;
  onMsg: (m: ServerMsg) => void = () => {};
  onSnap: (s: Snap[]) => void = () => {};
  onOpen: () => void = () => {};
  private posBuf = new ArrayBuffer(POS_BYTES);
  private posView = new DataView(this.posBuf);
  private retry = 0;

  constructor(private url: string) {}

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.onOpen(); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as ServerMsg;
        if (m.t === 'welcome') this.id = m.id;
        this.onMsg(m);
        return;
      }
      const v = new DataView(e.data as ArrayBuffer);
      if (v.getUint8(0) !== B_SNAP) return;
      const n = v.getUint16(1, true);
      const out: Snap[] = new Array(n);
      for (let i = 0, o = 3; i < n; i++, o += SNAP_ENTRY) {
        out[i] = { id: v.getUint16(o, true), x: v.getFloat32(o + 2, true), y: v.getFloat32(o + 6, true), z: v.getFloat32(o + 10, true), yaw: v.getFloat32(o + 14, true) };
      }
      this.onSnap(out);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      setTimeout(() => this.connect(), Math.min(250 * 2 ** this.retry++, 4000));
    };
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  send(m: ClientMsg) { if (this.open) this.ws!.send(JSON.stringify(m)); }

  sendPos(x: number, y: number, z: number, yaw: number) {
    if (!this.open) return;
    const v = this.posView;
    v.setUint8(0, B_POS);
    v.setFloat32(1, x, true); v.setFloat32(5, y, true); v.setFloat32(9, z, true); v.setFloat32(13, yaw, true);
    this.ws!.send(this.posBuf);
  }
}
