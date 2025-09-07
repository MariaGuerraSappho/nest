export class BluetoothManager {
    constructor() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.batteryService = null;
        this.modeCharacteristic = null;
        this.strengthCharacteristic = null;
        this.intervalCharacteristic = null;
        this.batteryLevelCharacteristic = null;
        this.listeners = {};
        this.batteryPollInterval = null;
        this.randomModeInterval = null;
        this.randomModeActive = false;
        this.currentRandomState = { buzzing: false, buzzDuration: 0, silenceDuration: 0 };
        this.gattQueue = [];
        this.gattBusy = false;
        this.SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
        this.MODE_CHARACTERISTIC_UUID = '12345678-1234-5678-1234-56789abcdef1';
        this.STRENGTH_CHARACTERISTIC_UUID = '12345678-1234-5678-1234-56789abcdef2';
        this.INTERVAL_CHARACTERISTIC_UUID = '12345678-1234-5678-1234-56789abcdef3';
        this.BATTERY_LEVEL_CHARACTERISTIC_UUID = '12345678-1234-5678-1234-56789abcdef4';
        console.log('🔵 BluetoothManager initialized');
    }
    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }
    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }
    async connect() {
        try {
            if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'BuzzBox' }],
                optionalServices: [this.SERVICE_UUID]
            });
            this.device.addEventListener('gattserverdisconnected', () => {
                this.stopBatteryPolling();
                this.emit('disconnected');
            });
            this.server = await this.device.gatt.connect();
            this.service = await this.server.getPrimaryService(this.SERVICE_UUID);
            this.modeCharacteristic = await this.service.getCharacteristic(this.MODE_CHARACTERISTIC_UUID);
            this.strengthCharacteristic = await this.service.getCharacteristic(this.STRENGTH_CHARACTERISTIC_UUID);
            this.intervalCharacteristic = await this.service.getCharacteristic(this.INTERVAL_CHARACTERISTIC_UUID);
            try {
                this.batteryLevelCharacteristic = await this.service.getCharacteristic(this.BATTERY_LEVEL_CHARACTERISTIC_UUID);
                await this.readBatteryLevel();
                this.startBatteryPolling();
            } catch (error) {
                this.emit('error', `Battery characteristic not available: ${error.message}`);
                this.emit('batteryUpdate', null);
            }
            this.emit('connected');
        } catch (error) {
            this.emit('error', error.message);
            throw error;
        }
    }
    startBatteryPolling() {
        this.stopBatteryPolling();
        this.batteryPollInterval = setInterval(async () => {
            try { await this.readBatteryLevel(); }
            catch (e) { this.emit('error', `Battery polling failed: ${e.message}`); this.emit('batteryUpdate', null); }
        }, 10000);
    }
    stopBatteryPolling() {
        if (this.batteryPollInterval) { clearInterval(this.batteryPollInterval); this.batteryPollInterval = null; }
    }
    async queueGattOperation(operation) {
        return new Promise((resolve, reject) => {
            this.gattQueue.push({ operation, resolve, reject });
            this.processGattQueue();
        });
    }
    async processGattQueue() {
        if (this.gattBusy || this.gattQueue.length === 0) return;
        this.gattBusy = true;
        const { operation, resolve, reject } = this.gattQueue.shift();
        try { const result = await operation(); resolve(result); }
        catch (e) { reject(e); }
        finally { this.gattBusy = false; setTimeout(() => this.processGattQueue(), 50); }
    }
    async readBatteryLevel() {
        try {
            if (!this.batteryLevelCharacteristic) return null;
            return await this.queueGattOperation(async () => {
                const value = await this.batteryLevelCharacteristic.readValue();
                const batteryLevel = value.getUint8(0);
                this.emit('batteryUpdate', batteryLevel);
                return batteryLevel;
            });
        } catch (error) {
            this.emit('error', `Failed to read battery level: ${error.message}`);
            this.emit('batteryUpdate', null);
            return null;
        }
    }
    async disconnect() {
        try {
            this.stopRandomMode();
            this.stopBatteryPolling();
            if (this.device && this.device.gatt.connected) await this.device.gatt.disconnect();
        } catch (error) {
            this.emit('error', error.message);
            throw error;
        }
    }
    async setMode(mode) {
        try {
            if (!this.modeCharacteristic) throw new Error('Mode characteristic not available');
            if (mode === 2) { this.startRandomMode(); this.emit('modeChanged', mode); return; }
            else if (mode === 3) { await this.singleBuzz(); this.emit('modeChanged', mode); return; }
            else { this.stopRandomMode(); }
            await this.queueGattOperation(async () => {
                const buffer = new Uint8Array([mode]);
                await this.modeCharacteristic.writeValue(buffer);
            });
            console.log(`🔵 Mode set to: ${mode}`);
            this.emit('modeChanged', mode);
        } catch (error) {
            this.emit('error', error.message);
            throw error;
        }
    }
    startRandomMode() {
        if (this.randomModeActive) this.stopRandomMode();
        this.randomModeActive = true;
        const runRandomCycle = async () => {
            if (!this.randomModeActive) return;
            const buzzDuration = 500 + Math.random() * 9500;
            const silenceDuration = 1000 + Math.random() * 4000;
            this.currentRandomState = { buzzing: true, buzzDuration: Math.round(buzzDuration), silenceDuration: Math.round(silenceDuration) };
            this.emit('randomStateChanged', this.currentRandomState);
            try {
                await this.writeMode(1);
                await this.delay(buzzDuration);
                if (!this.randomModeActive) return;
                await this.writeMode(0);
                this.currentRandomState.buzzing = false;
                this.emit('randomStateChanged', this.currentRandomState);
                await this.delay(silenceDuration);
                if (this.randomModeActive) this.randomModeInterval = setTimeout(runRandomCycle, 100);
            } catch (error) {
                console.error('🔵 Error in random mode:', error);
                this.emit('error', `Random mode error: ${error.message}`);
                this.stopRandomMode();
            }
        };
        runRandomCycle();
    }
    stopRandomMode() {
        if (this.randomModeInterval) { clearTimeout(this.randomModeInterval); this.randomModeInterval = null; }
        if (this.randomModeActive) {
            this.randomModeActive = false;
            this.writeMode(0).catch(() => { });
            this.emit('randomModeStopped');
        }
    }
    async singleBuzz() {
        try {
            await this.writeMode(1);
            await this.delay(200);
            await this.writeMode(0);
            this.emit('singleBuzzComplete');
        } catch (error) {
            this.emit('error', `Single buzz error: ${error.message}`);
        }
    }
    async writeMode(mode) {
        if (!this.modeCharacteristic) throw new Error('Mode characteristic not available');
        return await this.queueGattOperation(async () => {
            const buffer = new Uint8Array([mode]);
            await this.modeCharacteristic.writeValue(buffer);
        });
    }
    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    async setStrength(strength) {
        try {
            if (!this.strengthCharacteristic) throw new Error('Strength characteristic not available');
            await this.queueGattOperation(async () => {
                const buffer = new Uint8Array([strength]);
                await this.strengthCharacteristic.writeValue(buffer);
            });
        } catch (error) { this.emit('error', error.message); throw error; }
    }
    async setInterval(interval) {
        try {
            if (!this.intervalCharacteristic) throw new Error('Interval characteristic not available');
            await this.queueGattOperation(async () => {
                const buffer = new Uint8Array([interval]);
                await this.intervalCharacteristic.writeValue(buffer);
            });
        } catch (error) { this.emit('error', error.message); throw error; }
    }
    isConnected() { return this.device && this.device.gatt && this.device.gatt.connected; }
}