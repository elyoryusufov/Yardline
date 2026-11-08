import { i as __toESM } from "../_runtime.mjs";
import { K as require_react, b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as Power, i as Radio, n as TriangleAlert, o as Gauge, r as ShieldCheck, t as WifiOff } from "../_libs/lucide-react.mjs";
import { a as CartesianGrid, i as Line, n as YAxis, o as ResponsiveContainer, r as XAxis, s as Tooltip, t as LineChart } from "../_libs/recharts+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-DuOgwmTE.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var Kalman1D = class {
	q;
	r;
	x = 0;
	p = 1e3;
	constructor(q, r) {
		this.q = q;
		this.r = r;
	}
	predict(dtMs) {
		this.p += this.q * (dtMs / 1e3);
	}
	update(z, measR) {
		const k = this.p / (this.p + measR);
		this.x += k * (z - this.x);
		this.p *= 1 - k;
	}
	reset(v) {
		this.x = v;
		this.p = 1e3;
	}
	value() {
		return this.x;
	}
};
function gpsNoiseR(hdop) {
	return 4 + hdop * hdop;
}
function wrap(n, m) {
	return (n % m + m) % m;
}
/** Kindergarten street: 180 m approach, 80 m zone, 120 m exit. Loop. */
function zoneOf(distanceM) {
	const loop = 380;
	const d = wrap(distanceM, loop);
	return {
		d,
		inZone: d >= 180 && d < 260,
		loop
	};
}
function stepWorld(prev, dt, faults, limit) {
	const elapsed = (prev?.elapsed ?? 0) + dt;
	const base = 28 * (1 + Math.sin(elapsed * 2 * Math.PI / 36));
	let trueKmh = Math.max(0, base + Math.sin(elapsed * 1.7) * 1.2);
	if (faults.radarGlare) trueKmh = Math.min(trueKmh, 12);
	const distanceM = (prev?.distanceM ?? 40) + trueKmh / 3.6 * dt;
	const { d, inZone } = zoneOf(distanceM);
	const blackout = faults.canopy && inZone;
	const sats = blackout ? 3 : 8 + Math.round(Math.sin(elapsed) > 0 ? 2 : 0);
	const hdop = blackout ? 7.8 : 1.1 + (Math.sin(elapsed * .4) + 1) * .25;
	const gpsRaw = Math.max(0, trueKmh + Math.sin(elapsed * 3.1) * 2.4);
	const gpsKmh = blackout ? 0 : gpsRaw;
	const gpsOk = !blackout && sats >= 4 && hdop < 8;
	const wheelCut = faults.wheelCut;
	const wheelNoise = wheelCut ? 0 : Math.max(0, trueKmh + Math.sin(elapsed * 8) * .35);
	dt * 1e3;
	const meters = wheelNoise / 3.6 * dt;
	const pulses = wheelCut ? 0 : meters / 2;
	const wheelKmh = wheelCut ? 0 : pulses * 2 / dt * 3.6;
	const wheelFresh = !wheelCut && (trueKmh > .4 || pulses > 0);
	return {
		pulses,
		world: {
			elapsed,
			lat: 59.437 + Math.sin(elapsed / 120) * .002,
			lon: 24.7536 + d * 1e-5,
			trueKmh,
			gpsKmh: gpsOk ? gpsKmh : prev?.fusedKmh ?? 0,
			wheelKmh,
			fusedKmh: prev?.fusedKmh ?? 0,
			sats,
			hdop,
			gpsOk,
			wheelOk: false,
			wheelFresh,
			over: false,
			noData: false,
			inZone,
			distanceM
		}
	};
}
function fuse(kf, w, dtMs, limit, rising) {
	const wheelOk = w.wheelFresh || w.gpsOk && w.gpsKmh < 3;
	kf.predict(dtMs);
	if (w.gpsOk) kf.update(w.gpsKmh, gpsNoiseR(w.hdop));
	if (wheelOk && w.wheelFresh) kf.update(w.wheelKmh, 1);
	const fused = Math.max(0, kf.value());
	const noData = !w.gpsOk && !wheelOk;
	const over = (noData ? 0 : fused) > limit;
	return {
		event: over && !rising,
		world: {
			...w,
			fusedKmh: fused,
			wheelOk,
			over,
			noData,
			gpsKmh: w.gpsOk ? w.gpsKmh : fused
		}
	};
}
function scanResume(slots) {
	let best = 0;
	slots.forEach((r, i) => {
		if (r && r.seq > best && r.seq % 40 === i) best = r.seq;
	});
	return best + 1;
}
function serialApi() {
	if (typeof navigator === "undefined") return null;
	return navigator.serial ?? null;
}
function stampNow() {
	return (/* @__PURE__ */ new Date()).toLocaleTimeString("en-GB", { hour12: false });
}
async function openBoard(baudRate = 115200) {
	const api = serialApi();
	if (!api) throw new Error("USB serial is only available in Chrome or Edge.");
	const port = await api.requestPort();
	await port.open({ baudRate });
	const encoder = new TextEncoder();
	let writer = null;
	if (port.writable) writer = port.writable.getWriter();
	let reader = null;
	let stopped = false;
	return {
		port,
		write: async (text) => {
			if (!writer) throw new Error("Port is not writable.");
			await writer.write(encoder.encode(text));
		},
		read: async (onLine, onClose) => {
			if (!port.readable) return;
			reader = port.readable.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			try {
				while (!stopped) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let nl = buf.indexOf("\n");
					while (nl >= 0) {
						const line = buf.slice(0, nl).replace(/\r$/, "");
						buf = buf.slice(nl + 1);
						if (line.length) onLine(line);
						nl = buf.indexOf("\n");
					}
				}
			} catch {
				if (!stopped) onClose();
			} finally {
				onClose();
			}
		},
		close: async () => {
			stopped = true;
			try {
				await reader?.cancel();
			} catch {}
			try {
				reader?.releaseLock();
			} catch {}
			try {
				writer?.releaseLock();
			} catch {}
			try {
				await port.close();
			} catch {}
		}
	};
}
var LOG_KEY = "yardline-log-v1";
var PROBLEMS = [
	{
		title: "Cameras film children",
		body: "ANPR school cameras need faces and plates. They fail in rain, glare, and occlusion, and they store footage a kindergarten should not keep."
	},
	{
		title: "Radar lies at an angle",
		body: "Trailer radar has cosine error, confuses two cars, and cannot tell a stopped queue from a sensor that died."
	},
	{
		title: "GPS drops under trees",
		body: "Phone and puck GPS lose lock beside buildings and canopy. A frozen last speed looks like a real reading."
	},
	{
		title: "Evidence dies with the power",
		body: "Most loggers write straight to flash or to the cloud. A cut cord or a dead battery erases the overspeed that just happened."
	},
	{
		title: "One bad sensor goes quiet",
		body: "If the only sensor fails, the sign stays blank or keeps the old number. Staff never see a fault."
	}
];
function loadSlots() {
	if (typeof window === "undefined") return Array(40).fill(null);
	try {
		const raw = localStorage.getItem(LOG_KEY);
		if (!raw) return Array(40).fill(null);
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length !== 40) return Array(40).fill(null);
		return parsed;
	} catch {
		return Array(40).fill(null);
	}
}
function Home() {
	const [limit, setLimit] = (0, import_react.useState)(20);
	const [running, setRunning] = (0, import_react.useState)(true);
	const [faults, setFaults] = (0, import_react.useState)({
		canopy: false,
		wheelCut: false,
		radarGlare: false
	});
	const [slots, setSlots] = (0, import_react.useState)(() => Array(40).fill(null));
	const [booted, setBooted] = (0, import_react.useState)(false);
	const [resumed, setResumed] = (0, import_react.useState)(1);
	const [samples, setSamples] = (0, import_react.useState)([]);
	const [worldView, setWorldView] = (0, import_react.useState)({
		fused: 0,
		gps: 0,
		wheel: 0,
		trueKmh: 0,
		sats: 0,
		hdop: 0,
		gpsOk: false,
		wheelOk: false,
		over: false,
		noData: true,
		inZone: false,
		distanceM: 40,
		elapsed: 0,
		lat: 59.437,
		lon: 24.7536
	});
	const [banner, setBanner] = (0, import_react.useState)("Boot scan found an empty log. Watching the yard approach.");
	const [cut, setCut] = (0, import_react.useState)(false);
	const [usbOn, setUsbOn] = (0, import_react.useState)(false);
	const [usbReady, setUsbReady] = (0, import_react.useState)(false);
	const [usbError, setUsbError] = (0, import_react.useState)("");
	const [usbLines, setUsbLines] = (0, import_react.useState)([]);
	const [boardSpeed, setBoardSpeed] = (0, import_react.useState)(null);
	const closeUsb = (0, import_react.useRef)(null);
	const writeUsb = (0, import_react.useRef)(null);
	const limitRef = (0, import_react.useRef)(limit);
	const faultsRef = (0, import_react.useRef)(faults);
	const runningRef = (0, import_react.useRef)(running);
	const slotsRef = (0, import_react.useRef)(slots);
	const seqRef = (0, import_react.useRef)(1);
	const overRef = (0, import_react.useRef)(false);
	const kfRef = (0, import_react.useRef)(new Kalman1D(.8, 4));
	const worldRef = (0, import_react.useRef)(null);
	const lastLogRef = (0, import_react.useRef)(0);
	const dirtyRef = (0, import_react.useRef)(false);
	(0, import_react.useEffect)(() => {
		setUsbReady(serialApi() != null);
	}, []);
	(0, import_react.useEffect)(() => {
		limitRef.current = limit;
	}, [limit]);
	(0, import_react.useEffect)(() => {
		faultsRef.current = faults;
	}, [faults]);
	(0, import_react.useEffect)(() => {
		runningRef.current = running;
	}, [running]);
	(0, import_react.useEffect)(() => {
		slotsRef.current = slots;
	}, [slots]);
	(0, import_react.useEffect)(() => {
		const loaded = loadSlots();
		const next = scanResume(loaded);
		seqRef.current = next;
		setSlots(loaded);
		setResumed(next);
		const kept = loaded.filter((r) => !!r && r.seq > 0).sort((a, b) => a.seq - b.seq);
		setBanner(kept.length ? `Power restored. Log resumed at record ${next}. ${kept.length} slots still valid.` : "Boot scan found an empty log. Watching the yard approach.");
		setBooted(true);
	}, []);
	(0, import_react.useEffect)(() => {
		if (!booted) return;
		let raf = 0;
		let last = performance.now();
		let acc = 0;
		const tick = (now) => {
			const dt = Math.min(.25, (now - last) / 1e3);
			last = now;
			acc += dt;
			if (runningRef.current && !cut && dt > 0) {
				const stepped = stepWorld(worldRef.current, dt, faultsRef.current, limitRef.current);
				const fused = fuse(kfRef.current, stepped.world, dt * 1e3, limitRef.current, overRef.current);
				worldRef.current = fused.world;
				overRef.current = fused.world.over;
				const w = fused.world;
				const shown = w.noData ? 0 : w.fusedKmh;
				const recBase = {
					gpsOk: w.gpsOk,
					wheelOk: w.wheelOk,
					over: w.over,
					event: false,
					gpsWarn: !w.gpsOk,
					wheelWarn: !w.wheelOk,
					noData: w.noData
				};
				if (fused.event) {
					const rec = {
						seq: seqRef.current,
						speed: shown,
						gps: w.gpsOk ? w.gpsKmh : 0,
						wheel: w.wheelFresh ? w.wheelKmh : 0,
						limit: limitRef.current,
						flags: {
							...recBase,
							event: true
						},
						tSec: Math.floor(w.elapsed)
					};
					const nextSlots = slotsRef.current.slice();
					nextSlots[rec.seq % 40] = rec;
					seqRef.current += 1;
					slotsRef.current = nextSlots;
					dirtyRef.current = true;
					localStorage.setItem(LOG_KEY, JSON.stringify(nextSlots));
					dirtyRef.current = false;
					setSlots(nextSlots);
					setBanner(`Overspeed locked to disk at ${shown.toFixed(1)} km/h. A power cut cannot erase it.`);
				}
				if (w.elapsed - lastLogRef.current >= 1) {
					lastLogRef.current = w.elapsed;
					const rec = {
						seq: seqRef.current,
						speed: w.noData ? 0 : shown,
						gps: w.gpsOk ? w.gpsKmh : 0,
						wheel: w.wheelFresh ? w.wheelKmh : 0,
						limit: limitRef.current,
						flags: recBase,
						tSec: Math.floor(w.elapsed)
					};
					const nextSlots = slotsRef.current.slice();
					nextSlots[rec.seq % 40] = rec;
					seqRef.current += 1;
					slotsRef.current = nextSlots;
					dirtyRef.current = true;
					setSlots(nextSlots);
				}
				if (dirtyRef.current && Math.floor(w.elapsed) % 8 === 0) {
					localStorage.setItem(LOG_KEY, JSON.stringify(slotsRef.current));
					dirtyRef.current = false;
				}
				if (acc >= .2) {
					acc = 0;
					setWorldView({
						fused: shown,
						gps: w.gpsOk ? stepped.world.gpsKmh : 0,
						wheel: w.wheelFresh ? w.wheelKmh : 0,
						trueKmh: w.trueKmh,
						sats: w.sats,
						hdop: w.hdop,
						gpsOk: w.gpsOk,
						wheelOk: w.wheelOk,
						over: w.over,
						noData: w.noData,
						inZone: w.inZone,
						distanceM: w.distanceM,
						elapsed: w.elapsed,
						lat: w.lat,
						lon: w.lon
					});
					setSamples((prev) => {
						const row = {
							t: Math.round(w.elapsed * 10) / 10,
							gps: w.gpsOk ? stepped.world.gpsKmh : 0,
							wheel: w.wheelFresh ? w.wheelKmh : 0,
							fused: shown,
							limit: limitRef.current
						};
						const next = prev.length > 40 ? prev.slice(prev.length - 40) : prev.slice();
						next.push(row);
						return next;
					});
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [booted, cut]);
	const records = (0, import_react.useMemo)(() => slots.filter((r) => !!r && r.seq > 0).sort((a, b) => b.seq - a.seq), [slots]);
	const events = records.filter((r) => r.flags.event).length;
	const zone = zoneOf(worldView.distanceM);
	const carPct = zone.d / zone.loop * 100;
	function persistNow() {
		localStorage.setItem(LOG_KEY, JSON.stringify(slotsRef.current));
		dirtyRef.current = false;
	}
	function powerCut() {
		persistNow();
		setRunning(false);
		setCut(true);
		setBanner("Mains cut. Display is dark. The circular log is still in this computer’s storage.");
	}
	function restore() {
		const loaded = loadSlots();
		const next = scanResume(loaded);
		seqRef.current = next;
		slotsRef.current = loaded;
		setSlots(loaded);
		setResumed(next);
		setCut(false);
		setRunning(true);
		overRef.current = false;
		kfRef.current.reset(0);
		worldRef.current = null;
		setBanner(`Boot scan accepted sequence ${next - 1}. Tracking resumed without a cloud.`);
	}
	function clearLog() {
		const empty = Array(40).fill(null);
		slotsRef.current = empty;
		seqRef.current = 1;
		setSlots(empty);
		localStorage.setItem(LOG_KEY, JSON.stringify(empty));
		setBanner("Log cleared on this computer. Next overspeed starts at record 1.");
	}
	function noteUsb(text) {
		setUsbLines((prev) => [...prev.slice(-40), {
			stamp: stampNow(),
			text
		}]);
	}
	function takeBoardLine(line) {
		noteUsb(line);
		const limitHit = line.match(/Limit ->\s*(\d+(?:\.\d+)?)/);
		if (limitHit) setLimit(Number(limitHit[1]));
		const eventHit = line.match(/OVERSPEED\s+([\d.]+)\s*km\/h\s*\(limit\s*([\d.]+)\)/i);
		if (eventHit) {
			setBoardSpeed(Number(eventHit[1]));
			setLimit(Number(eventHit[2]));
			setBanner(`Board reported overspeed ${eventHit[1]} km/h.`);
		}
		const recHit = line.match(/^#(\d+)\s+(\d+)s\s+([\d.]+)\s*km\/h\s+flags=0x([0-9A-Fa-f]+)/);
		if (recHit) setBoardSpeed(Number(recHit[3]));
	}
	async function connectUsb() {
		setUsbError("");
		try {
			const link = await openBoard(115200);
			closeUsb.current = link.close;
			writeUsb.current = link.write;
			setUsbOn(true);
			noteUsb("Port open at 115200. Waiting for the ESP32.");
			link.read(takeBoardLine, () => {
				setUsbOn(false);
				closeUsb.current = null;
				writeUsb.current = null;
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not open the port.";
			if (!/cancel|aborted|No port/i.test(message)) setUsbError(message);
		}
	}
	async function disconnectUsb() {
		await closeUsb.current?.();
		closeUsb.current = null;
		writeUsb.current = null;
		setUsbOn(false);
		noteUsb("Port closed.");
	}
	async function sendCmd(cmd) {
		if (!writeUsb.current) return;
		try {
			await writeUsb.current(cmd);
			noteUsb(`Sent '${cmd.trim()}'`);
		} catch (err) {
			setUsbError(err instanceof Error ? err.message : "Write failed.");
		}
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "min-h-screen bg-bg text-ink",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", {
				className: "border-b border-line bg-surface",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-4 py-5 sm:px-6",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-xs font-medium uppercase text-amber",
							children: "Kindergarten yard"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
							className: "font-display text-4xl font-medium tracking-tight",
							children: "Yardline"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-1 max-w-xl text-sm text-muted",
							children: "Desk prototype of your ESP32 tracker: GPS plus a wheel sensor, Kalman fusion, and a log that survives a power cut. No cameras on children."
						})
					] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap gap-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setRunning((v) => !v),
								disabled: cut,
								className: "h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg disabled:opacity-40",
								children: running ? "Pause street" : "Run street"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: powerCut,
								className: "h-11 rounded-full border border-line bg-chip px-4 text-sm font-medium",
								children: "Cut power"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: restore,
								className: "h-11 rounded-full border border-line bg-surface px-4 text-sm font-medium",
								children: "Boot again"
							})
						]
					})]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", {
				className: "mx-auto mt-4 max-w-6xl px-4 sm:px-6",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-2xl border border-line bg-surface p-4 sm:p-5",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center justify-between gap-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "font-display text-xl",
								children: "Board link"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted",
								children: usbReady ? "Chrome or Edge can open the ESP32 USB port at 115200. The sketch answers u, d, p, and c." : "USB serial appears after the page loads in Chrome or Edge. Other browsers cannot open the port."
							})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-wrap gap-2",
								children: [
									usbOn ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => void disconnectUsb(),
										className: "h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg",
										children: "Disconnect"
									}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => void connectUsb(),
										disabled: !usbReady,
										className: "h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg disabled:opacity-40",
										children: "Connect ESP32"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !usbOn,
										onClick: () => void sendCmd("u"),
										className: "h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40",
										children: "Limit +5"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !usbOn,
										onClick: () => void sendCmd("d"),
										className: "h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40",
										children: "Limit −5"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !usbOn,
										onClick: () => void sendCmd("p"),
										className: "h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40",
										children: "Read flash"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !usbOn,
										onClick: () => void sendCmd("c"),
										className: "h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40",
										children: "Wipe flash"
									})
								]
							})]
						}),
						usbError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-2 text-sm text-alert",
							children: usbError
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-3 text-sm text-muted",
							children: [
								"Last speed from the board: ",
								boardSpeed == null ? "none yet" : `${boardSpeed.toFixed(1)} km/h`,
								". The big number above stays the desk simulation until the board prints an overspeed or a log line. Plug in the ESP32, then press Connect and choose its port."
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
							className: "mt-3 max-h-40 overflow-auto rounded-xl bg-chip p-3 font-mono text-xs leading-5 text-ink",
							children: usbLines.length === 0 ? "No USB text yet." : usbLines.map((l) => `[${l.stamp}] ${l.text}`).join("\n")
						})
					]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mx-auto grid max-w-6xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[1.4fr_0.8fr]",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
						className: "rounded-2xl border border-line bg-surface p-4 sm:p-5",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-start justify-between gap-3",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "text-xs uppercase text-muted",
										children: "Fused speed"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: `font-display text-7xl leading-none ${worldView.over ? "text-alert" : "text-ink"}`,
										children: cut ? "—" : Math.round(worldView.fused)
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "mt-1 text-sm text-muted",
										children: "km/h shown to the gate sign"
									})
								] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Status, {
									world: worldView,
									cut,
									limit
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Road, {
								carPct,
								inZone: worldView.inZone,
								cut
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-4 grid grid-cols-3 gap-2 text-sm",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meter, {
										label: "GPS",
										value: worldView.gpsOk ? worldView.gps.toFixed(1) : "lost",
										hint: `${worldView.sats} sats · HDOP ${worldView.hdop.toFixed(1)}`,
										bad: !worldView.gpsOk
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meter, {
										label: "Wheel",
										value: worldView.wheelOk && worldView.wheel > 0 ? worldView.wheel.toFixed(1) : worldView.wheelOk ? "idle" : "fault",
										hint: "Hall interrupt",
										bad: !worldView.wheelOk
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meter, {
										label: "Truth",
										value: worldView.trueKmh.toFixed(1),
										hint: "hidden from the sign",
										bad: false
									})
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "mt-4 h-48",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResponsiveContainer, {
									width: "100%",
									height: "100%",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(LineChart, {
										data: samples,
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CartesianGrid, {
												stroke: "#e3d9cb",
												vertical: false
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(XAxis, {
												dataKey: "t",
												hide: true
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(YAxis, {
												width: 28,
												tick: {
													fill: "#6d655c",
													fontSize: 11
												},
												axisLine: false,
												tickLine: false
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Tooltip, { contentStyle: {
												background: "#fffdf8",
												border: "1px solid #e3d9cb",
												borderRadius: 12,
												fontSize: 12
											} }),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Line, {
												type: "monotone",
												dataKey: "gps",
												name: "GPS",
												stroke: "#6d655c",
												dot: false,
												strokeWidth: 1.5
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Line, {
												type: "monotone",
												dataKey: "wheel",
												name: "Wheel",
												stroke: "#1f6b4a",
												dot: false,
												strokeWidth: 1.5
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Line, {
												type: "monotone",
												dataKey: "fused",
												name: "Fused",
												stroke: "#c56a12",
												dot: false,
												strokeWidth: 2.2
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Line, {
												type: "monotone",
												dataKey: "limit",
												name: "Limit",
												stroke: "#b42318",
												dot: false,
												strokeDasharray: "4 4",
												strokeWidth: 1
											})
										]
									})
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-xs text-muted",
								children: "Amber is what the sign trusts. Grey GPS jumps; green wheel is tighter. The red dash is the live limit."
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
						className: "flex flex-col gap-4",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
							className: "rounded-2xl border border-line bg-surface p-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
										className: "font-display text-xl",
										children: "Zone limit"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "font-display text-3xl",
										children: limit
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-sm text-muted",
									children: "Inside the yellow band the safe yard limit is 20 km/h. Buttons step by 5, same as the gate hardware."
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mt-3 flex gap-2",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										className: "h-11 flex-1 rounded-full bg-chip text-sm font-medium",
										onClick: () => setLimit((n) => Math.max(5, n - 5)),
										children: "−5"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										className: "h-11 flex-1 rounded-full bg-ink text-sm font-medium text-bg",
										onClick: () => setLimit((n) => Math.min(80, n + 5)),
										children: "+5"
									})]
								}),
								worldView.inZone && limit !== 20 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									type: "button",
									className: "mt-3 h-11 w-full rounded-full bg-amber-soft text-sm font-medium text-amber",
									onClick: () => setLimit(20),
									children: "Set yard limit to 20"
								})
							]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
							className: "rounded-2xl border border-line bg-surface p-4",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "font-display text-xl",
								children: "Break a commercial unit"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-3 flex flex-col gap-2",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fault, {
										on: faults.canopy,
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WifiOff, { size: 16 }),
										title: "Tree canopy",
										body: "GPS sats fall under 4 beside the yard. Fusion keeps the wheel.",
										toggle: () => setFaults((f) => ({
											...f,
											canopy: !f.canopy
										}))
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fault, {
										on: faults.wheelCut,
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Radio, { size: 16 }),
										title: "Wheel wire cut",
										body: "If GPS still says the car is moving, the sign flags the sensor.",
										toggle: () => setFaults((f) => ({
											...f,
											wheelCut: !f.wheelCut
										}))
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fault, {
										on: faults.radarGlare,
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, { size: 16 }),
										title: "Slow queue",
										body: "Cars crawl. A radar trailer often alarms; silence at a standstill does not.",
										toggle: () => setFaults((f) => ({
											...f,
											radarGlare: !f.radarGlare
										}))
									})
								]
							})]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
						className: "rounded-2xl border border-line bg-surface p-4 sm:p-5 lg:col-span-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center justify-between gap-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "font-display text-xl",
								children: "Evidence log"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted",
								children: banner
							})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex gap-2 text-sm",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "rounded-full bg-chip px-3 py-2",
										children: [events, " incidents"]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "rounded-full bg-chip px-3 py-2",
										children: ["next #", resumed > seqRef.current ? resumed : seqSafe(slots)]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: clearLog,
										className: "rounded-full border border-line px-3 py-2",
										children: "Clear log"
									})
								]
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "mt-3 max-h-64 overflow-auto",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
								className: "w-full text-left text-sm",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
									className: "text-xs uppercase tracking-wide text-muted",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "py-2 pr-3 font-medium",
											children: "Seq"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "py-2 pr-3 font-medium",
											children: "Time"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "py-2 pr-3 font-medium",
											children: "km/h"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "py-2 pr-3 font-medium",
											children: "Limit"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "py-2 font-medium",
											children: "Flags"
										})
									] })
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tbody", { children: [records.slice(0, 12).map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
									className: "border-t border-line",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "py-2 pr-3",
											children: r.seq
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
											className: "py-2 pr-3",
											children: [r.tSec, "s"]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "py-2 pr-3",
											children: r.speed.toFixed(1)
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "py-2 pr-3",
											children: r.limit
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
											className: "py-2",
											children: [
												r.flags.event ? "EVENT " : "",
												r.flags.gpsOk ? "G" : "g!",
												" ",
												r.flags.wheelOk ? "W" : "w!",
												" ",
												r.flags.over ? "OVER" : "",
												r.flags.noData ? " NO DATA" : ""
											]
										})
									]
								}, r.seq)), records.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									colSpan: 5,
									className: "py-6 text-muted",
									children: "No records yet. Leave the street running for a second."
								}) })] })]
							})
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
						className: "lg:col-span-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "font-display text-2xl",
								children: "What current trackers still get wrong"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "mt-3 grid gap-3 md:grid-cols-5",
								children: PROBLEMS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
									className: "rounded-2xl border border-line bg-surface p-4",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
										className: "text-sm font-semibold",
										children: p.title
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "mt-2 text-sm text-muted",
										children: p.body
									})]
								}, p.title))
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", {
								className: "mt-4 grid gap-2 text-sm md:grid-cols-2",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fix, {
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldCheck, { size: 16 }),
										text: "No plates, no faces. Speed only, from the car’s own wheel and a GPS puck."
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fix, {
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gauge, { size: 16 }),
										text: "Kalman trusts the wheel when HDOP blows up, and trusts GPS when the wheel wire is quiet at a standstill."
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fix, {
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Power, { size: 16 }),
										text: "Overspeed flushes immediately into a 40-slot ring. Boot scans sequence numbers and continues."
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fix, {
										icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, { size: 16 }),
										text: "If both sensors die, the sign shows 0 and NO SENSOR DATA instead of a stale speed."
									})
								]
							})
						]
					})
				]
			})
		]
	});
}
function seqSafe(slots) {
	return scanResume(slots);
}
function Status({ world, cut, limit }) {
	if (cut) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "alert",
		children: "POWER LOST"
	});
	if (world.noData) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "alert",
		children: "NO SENSOR DATA"
	});
	if (world.over) return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Pill, {
		tone: "alert",
		children: ["OVER ", limit]
	});
	if (!world.gpsOk) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "amber",
		children: "GPS LOST · wheel hold"
	});
	if (!world.wheelOk) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "amber",
		children: "WHEEL SENSOR"
	});
	if (world.inZone) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "safe",
		children: "IN YARD"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pill, {
		tone: "safe",
		children: "CLEAR"
	});
}
function Pill({ children, tone }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: `rounded-full px-3 py-2 text-xs font-semibold tracking-wide ${tone === "alert" ? "bg-alert-soft text-alert" : tone === "amber" ? "bg-amber-soft text-amber" : "bg-safe-soft text-safe"}`,
		children
	});
}
function Meter({ label, value, hint, bad }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: `rounded-xl px-3 py-2 ${bad ? "bg-alert-soft" : "bg-chip"}`,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs uppercase tracking-wide text-muted",
				children: label
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-display text-2xl",
				children: value
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted",
				children: hint
			})
		]
	});
}
function Road({ carPct, inZone, cut }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-5",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "relative h-16 overflow-hidden rounded-xl bg-chip",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-y-0 left-[47%] w-[21%] bg-amber-soft" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "absolute left-3 top-2 text-xs text-muted",
					children: "Approach"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "absolute left-[49%] top-2 text-xs font-medium text-amber",
					children: "Yard"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "absolute right-3 top-2 text-xs text-muted",
					children: "Exit"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-x-0 top-9 h-1 bg-line" }),
				!cut && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "absolute top-6 size-5 rounded-sm bg-ink",
					style: { left: `calc(${carPct}% - 10px)` },
					"aria-hidden": true
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "mt-2 text-xs text-muted",
			children: inZone ? "Car is inside the kindergarten band." : "Car is outside the band. Limit stays at the gate setting."
		})]
	});
}
function Fault({ on, icon, title, body, toggle }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		onClick: toggle,
		className: `rounded-xl border px-3 py-3 text-left ${on ? "border-amber bg-amber-soft" : "border-line bg-surface"}`,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
			className: "flex items-center gap-2 text-sm font-semibold",
			children: [icon, title]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "mt-1 block text-xs text-muted",
			children: body
		})]
	});
}
function Fix({ icon, text }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
		className: "flex gap-2 rounded-xl border border-line bg-surface px-3 py-3",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "mt-0.5 text-safe",
			children: icon
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: text })]
	});
}
//#endregion
export { Home as component };
