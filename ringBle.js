export class RingBLE {
  constructor(logFn = () => {}) {
    this.log = logFn;
    this.device = null;
    this.server = null;
    this.ctrlService = null;
    this.ctrlWrite = null;
    this.ctrlNotify = null;
    this.mainService = null;
    this.settingsWrite = null;
    this.settingsNotify = null;

    this.onHeartRate = null;
    this.onMotion = null;
    this.hrTimer = null;
    this.keepAliveTimer = null; 
    this.lastHrAt = 0; 
    this.lastMotionAt = 0;
    this.onWorn = null; 
    this.onBattery = null;
    
    this._ppgMin = 1e9; 
    this._ppgMax = -1e9; 
    this._ppgSmooth = 0; 
    this._ppgPrevSmooth = 0;
    this._lastPeakMs = 0; 
    this._ibis = [];
    this._lastA1Log = 0;
    this._a1Count = 0;
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      optionalServices: [
        'de5bf728-d711-4e47-af26-65e3012a5dc7',
        '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e'
      ],
      acceptAllDevices: true
    });
    this.device.addEventListener('gattserverdisconnected', () => { 
      this.log('Disconnected.'); 
      clearInterval(this.hrTimer); 
      this.hrTimer = null; 
    });
    this.server = await this.device.gatt.connect();

    // Control service
    this.ctrlService = await this.server.getPrimaryService('de5bf728-d711-4e47-af26-65e3012a5dc7');
    this.ctrlWrite = await this.ctrlService.getCharacteristic('de5bf72a-d711-4e47-af26-65e3012a5dc7');
    this.ctrlNotify = await this.ctrlService.getCharacteristic('de5bf729-d711-4e47-af26-65e3012a5dc7');
    await this.ctrlNotify.startNotifications();
    this.ctrlNotify.addEventListener('characteristicvaluechanged', e => {
      const dv = e.target.value;
      const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      this._handleNotify(bytesToHex(u8));
    });

    // Main RX/TX service
    this.mainService = await this.server.getPrimaryService('6e40fff0-b5a3-f393-e0a9-e50e24dcca9e');
    this.settingsWrite = await this.mainService.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e');
    this.settingsNotify = await this.mainService.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
    await this.settingsNotify.startNotifications();
    this.settingsNotify.addEventListener('characteristicvaluechanged', e => {
      const dv = e.target.value;
      const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      this._handleSettingsBytes(u8);
    });

    this.log('Connected. Getting battery/state...');
    await this._sendSettingsArray(hexToBytes('03')); // get battery/status
  }

  async enableRaw() {
    this.log('Enabling raw sensor data…');
    await new Promise(r => setTimeout(r, 150));
    await this._sendSettingsArray(hexToBytes('03'));
    await this._sendSettingsArray(hexToBytes('A10404'));
    setTimeout(() => this._sendSettingsArray(hexToBytes('A10304')).catch(()=>{}), 400);
    this.startHeartRate();
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      try {
        await this._sendSettingsArray(hexToBytes('03'));
        await this._sendSettingsArray(hexToBytes('A10404'));
        const now = Date.now();
        if (now - this.lastHrAt > 6000) await this._sendCtrlCmd('69', '0101');
      } catch {}
    }, 4000);
  }

  startHeartRate() {
    clearInterval(this.hrTimer);
    const tick = async () => { try { await this._sendCtrlCmd('69', '0101'); } catch {} };
    tick();
    this.hrTimer = setInterval(tick, 1500);
  }

  _handleNotify(hex) {
    // keep for completeness; OTA/ACK not used here
    this.log('Notify: ' + hex);
  }

  _handleSettings(hexStr) {
    const data = hexToBytes(hexStr);
    this._handleSettingsBytes(data);
  }

  _handleSettingsBytes(data) {
    if (data.length !== 16) return;
    let sum = 0; 
    for (let i = 0; i < 15; i++) sum = (sum + data[i]) & 0xff;
    if (sum !== data[15]) return;

    switch (data[0]) {
      case 0x69: {
        const worn = data[2] === 0; 
        const bpm = data[3];
        this.onWorn && this.onWorn(worn);
        if (bpm && bpm >= 25 && bpm <= 220) { 
          this.lastHrAt = Date.now(); 
          this.onHeartRate && this.onHeartRate(bpm, false); 
        }
        break;
      }
      case 0xA1: {
        if (data[1] === 1) { 
          this._ppgSample(((data[2]<<8)|data[3])>32767?((data[2]<<8)|data[3])-65536:((data[2]<<8)|data[3]));
        }
        if (data[1] === 3) {
          const rawY = int12(((data[2] << 4) | (data[3] & 0x0f)) & 0x0fff);
          const rawZ = int12(((data[4] << 4) | (data[5] & 0x0f)) & 0x0fff);
          const rawX = int12(((data[6] << 4) | (data[7] & 0x0f)) & 0x0fff);
          const Ax = convertRawToG(rawX), Ay = convertRawToG(rawY), Az = convertRawToG(rawZ);
          const mag = Math.sqrt(Ax*Ax + Ay*Ay + Az*Az); 
          this.lastMotionAt = Date.now();
          this.onMotion && this.onMotion(mag);
          this._a1Count++;
          this.log(`A1#${this._a1Count} ${bytesToHex(data)} | Ax=${Ax.toFixed(3)}g Ay=${Ay.toFixed(3)}g Az=${Az.toFixed(3)}g mag=${mag.toFixed(3)}g`);
        }
        break;
      }
      case 0x73: { 
        if (data[1] === 0x0C) { 
          this.onBattery && this.onBattery(data[2]); 
        } 
        break; 
      }
      case 0x03:  { 
        if (data[1] !== 0) { 
          this.onBattery && this.onBattery(data[1]); 
        } 
        break; 
      }
      default: break;
    }
  }

  async _sendCtrl(bytes) {
    if (!this.ctrlWrite) return;
    await this.ctrlWrite.writeValue(bytes);
  }

  async _sendCtrlCmd(typeHex, dataHex) {
    if (!this.ctrlWrite) return;
    const typeByte = parseInt(typeHex, 16);
    const payload = dataHex ? hexToBytes(dataHex) : new Uint8Array(0);
    const frame = buildAtcCtrlFrame(typeByte, payload);
    await this._sendCtrl(frame);
  }

  async _sendSettings(bytes) {
    if (!this.settingsWrite) return;
    await this.settingsWrite.writeValue(bytes);
  }

  async _sendSettingsArray(arr) {
    if (arr.length > 15) throw new Error('Data too long');
    const out = new Uint8Array(16);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i] & 0xff;
      out[15] = (out[15] + out[i]) & 0xff;
    }
    await this._sendSettings(out);
  }

  _ppgSample(v) {
    const nowMs = Date.now();
    this._ppgMin = Math.min(this._ppgMin*0.999 + v*0.001, v);
    this._ppgMax = Math.max(this._ppgMax*0.999 + v*0.001, v);
    const span = Math.max(1, this._ppgMax - this._ppgMin);
    const norm = (v - this._ppgMin) / span;
    this._ppgPrevSmooth = this._ppgSmooth;
    this._ppgSmooth = this._ppgSmooth + 0.15 * (norm - this._ppgSmooth);
    const rising = this._ppgSmooth - this._ppgPrevSmooth;
    const refractory = 350;
    if (rising > 0.002 && (nowMs - this._lastPeakMs) > refractory) {
      const ibi = nowMs - this._lastPeakMs; 
      this._lastPeakMs = nowMs;
      if (ibi > 300 && ibi < 2000) { 
        this._ibis.push(ibi); 
        if (this._ibis.length > 7) this._ibis.shift(); 
      }
      if (Date.now() - this.lastHrAt > 3000 && this._ibis.length >= 3) {
        const sorted = [...this._ibis].sort((a,b)=>a-b); 
        const mid = Math.floor(sorted.length/2);
        const medIbi = sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
        let bpm = Math.round(60000/medIbi); 
        bpm = Math.max(30, Math.min(180, bpm));
        if (bpm >= 25 && bpm <= 220) this.onHeartRate && this.onHeartRate(bpm, true);
      }
    }
  }
}

function int12(uint12) { return uint12 > 2047 ? uint12 - 4096 : uint12; }
function convertRawToG(rawValue) { const rangeG = 4; return (rawValue / 2048) * rangeG; }
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0, j = 0; i < hex.length; i += 2, j++) out[j] = parseInt(hex.substr(i, 2), 16);
  return out;
}
function bytesToHex(data) {
  const a = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
  let out = '';
  for (let i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
  return out;
}

function crc16(bytes){let crc=0xffff;for(let i=0;i<bytes.length;i++){crc^=(bytes[i]&0xff);for(let b=0;b<8;b++){crc=(crc&1)?((crc>>1)^0xA001):(crc>>1);}}return crc&0xffff;}
function buildAtcCtrlFrame(typeByte,payload){const len=payload?payload.length:0;const out=new Uint8Array(len+6);out[0]=0xBC;out[1]=typeByte&0xff;out[2]=len&0xff;out[3]=(len>>8)&0xff;let c=len?crc16(payload):0xffff;out[4]=c&0xff;out[5]=(c>>8)&0xff;if(len)for(let i=0;i<len;i++)out[6+i]=payload[i]&0xff;return out;}