import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Gauge,
  Power,
  Radio,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DEFAULT_LIMIT,
  type Faults,
  type LogRec,
  type Sample,
  Kalman1D,
  SLOT_COUNT,
  fuse,
  scanResume,
  stepWorld,
  zoneOf,
} from "@/lib/yardline";
import { openBoard, serialApi, stampNow, type SerialLine } from "@/lib/board-serial";

export const Route = createFileRoute("/")({ component: Home });

const LOG_KEY = "yardline-log-v1";

const PROBLEMS = [
  {
    title: "Cameras film children",
    body: "ANPR school cameras need faces and plates. They fail in rain, glare, and occlusion, and they store footage a kindergarten should not keep.",
  },
  {
    title: "Radar lies at an angle",
    body: "Trailer radar has cosine error, confuses two cars, and cannot tell a stopped queue from a sensor that died.",
  },
  {
    title: "GPS drops under trees",
    body: "Phone and puck GPS lose lock beside buildings and canopy. A frozen last speed looks like a real reading.",
  },
  {
    title: "Evidence dies with the power",
    body: "Most loggers write straight to flash or to the cloud. A cut cord or a dead battery erases the overspeed that just happened.",
  },
  {
    title: "One bad sensor goes quiet",
    body: "If the only sensor fails, the sign stays blank or keeps the old number. Staff never see a fault.",
  },
];

function loadSlots(): Array<LogRec | null> {
  if (typeof window === "undefined") return Array(SLOT_COUNT).fill(null);
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return Array(SLOT_COUNT).fill(null);
    const parsed = JSON.parse(raw) as Array<LogRec | null>;
    if (!Array.isArray(parsed) || parsed.length !== SLOT_COUNT) return Array(SLOT_COUNT).fill(null);
    return parsed;
  } catch {
    return Array(SLOT_COUNT).fill(null);
  }
}

function Home() {
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [running, setRunning] = useState(true);
  const [faults, setFaults] = useState<Faults>({ canopy: false, wheelCut: false, radarGlare: false });
  const [slots, setSlots] = useState<Array<LogRec | null>>(() => Array(SLOT_COUNT).fill(null));
  const [booted, setBooted] = useState(false);
  const [resumed, setResumed] = useState(1);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [worldView, setWorldView] = useState({
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
    lon: 24.7536,
  });
  const [banner, setBanner] = useState("Boot scan found an empty log. Watching the yard approach.");
  const [cut, setCut] = useState(false);
  const [usbOn, setUsbOn] = useState(false);
  const [usbReady, setUsbReady] = useState(false);
  const [usbError, setUsbError] = useState("");
  const [usbLines, setUsbLines] = useState<SerialLine[]>([]);
  const [boardSpeed, setBoardSpeed] = useState<number | null>(null);
  const closeUsb = useRef<null | (() => Promise<void>)>(null);
  const writeUsb = useRef<null | ((text: string) => Promise<void>)>(null);

  const limitRef = useRef(limit);
  const faultsRef = useRef(faults);
  const runningRef = useRef(running);
  const slotsRef = useRef(slots);
  const seqRef = useRef(1);
  const overRef = useRef(false);
  const kfRef = useRef(new Kalman1D(0.8, 4));
  const worldRef = useRef<ReturnType<typeof stepWorld>["world"] | null>(null);
  const lastLogRef = useRef(0);
  const dirtyRef = useRef(false);

  useEffect(() => { setUsbReady(serialApi() != null); }, []);
  useEffect(() => { limitRef.current = limit; }, [limit]);
  useEffect(() => { faultsRef.current = faults; }, [faults]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { slotsRef.current = slots; }, [slots]);

  useEffect(() => {
    const loaded = loadSlots();
    const next = scanResume(loaded);
    seqRef.current = next;
    setSlots(loaded);
    setResumed(next);
    const kept = loaded.filter((r): r is LogRec => !!r && r.seq > 0).sort((a, b) => a.seq - b.seq);
    setBanner(
      kept.length
        ? `Power restored. Log resumed at record ${next}. ${kept.length} slots still valid.`
        : "Boot scan found an empty log. Watching the yard approach.",
    );
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      acc += dt;
      if (runningRef.current && !cut && dt > 0) {
        const stepped = stepWorld(worldRef.current, dt, faultsRef.current, limitRef.current);
        const fused = fuse(kfRef.current, stepped.world, dt * 1000, limitRef.current, overRef.current);
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
          noData: w.noData,
        };
        if (fused.event) {
          const rec: LogRec = {
            seq: seqRef.current,
            speed: shown,
            gps: w.gpsOk ? w.gpsKmh : 0,
            wheel: w.wheelFresh ? w.wheelKmh : 0,
            limit: limitRef.current,
            flags: { ...recBase, event: true },
            tSec: Math.floor(w.elapsed),
          };
          const nextSlots = slotsRef.current.slice();
          nextSlots[rec.seq % SLOT_COUNT] = rec;
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
          const rec: LogRec = {
            seq: seqRef.current,
            speed: w.noData ? 0 : shown,
            gps: w.gpsOk ? w.gpsKmh : 0,
            wheel: w.wheelFresh ? w.wheelKmh : 0,
            limit: limitRef.current,
            flags: recBase,
            tSec: Math.floor(w.elapsed),
          };
          const nextSlots = slotsRef.current.slice();
          nextSlots[rec.seq % SLOT_COUNT] = rec;
          seqRef.current += 1;
          slotsRef.current = nextSlots;
          dirtyRef.current = true;
          setSlots(nextSlots);
        }
        if (dirtyRef.current && Math.floor(w.elapsed) % 8 === 0) {
          localStorage.setItem(LOG_KEY, JSON.stringify(slotsRef.current));
          dirtyRef.current = false;
        }
        if (acc >= 0.2) {
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
            lon: w.lon,
          });
          setSamples((prev) => {
            const row: Sample = {
              t: Math.round(w.elapsed * 10) / 10,
              gps: w.gpsOk ? stepped.world.gpsKmh : 0,
              wheel: w.wheelFresh ? w.wheelKmh : 0,
              fused: shown,
              limit: limitRef.current,
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

  const records = useMemo(
    () => slots.filter((r): r is LogRec => !!r && r.seq > 0).sort((a, b) => b.seq - a.seq),
    [slots],
  );
  const events = records.filter((r) => r.flags.event).length;
  const zone = zoneOf(worldView.distanceM);
  const carPct = (zone.d / zone.loop) * 100;

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
    const empty = Array(SLOT_COUNT).fill(null);
    slotsRef.current = empty;
    seqRef.current = 1;
    setSlots(empty);
    localStorage.setItem(LOG_KEY, JSON.stringify(empty));
    setBanner("Log cleared on this computer. Next overspeed starts at record 1.");
  }

  function noteUsb(text: string) {
    setUsbLines((prev) => [...prev.slice(-40), { stamp: stampNow(), text }]);
  }

  function takeBoardLine(line: string) {
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
      void link.read(takeBoardLine, () => {
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

  async function sendCmd(cmd: string) {
    if (!writeUsb.current) return;
    try {
      await writeUsb.current(cmd);
      noteUsb(`Sent '${cmd.trim()}'`);
    } catch (err) {
      setUsbError(err instanceof Error ? err.message : "Write failed.");
    }
  }

  return (
    <main className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-4 py-5 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase text-amber">Kindergarten yard</p>
            <h1 className="font-display text-4xl font-medium tracking-tight">Yardline</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Desk prototype of your ESP32 tracker: GPS plus a wheel sensor, Kalman fusion, and a log that survives a power cut. No cameras on children.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setRunning((v) => !v)} disabled={cut} className="h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg disabled:opacity-40">
              {running ? "Pause street" : "Run street"}
            </button>
            <button type="button" onClick={powerCut} className="h-11 rounded-full border border-line bg-chip px-4 text-sm font-medium">
              Cut power
            </button>
            <button type="button" onClick={restore} className="h-11 rounded-full border border-line bg-surface px-4 text-sm font-medium">
              Boot again
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto mt-4 max-w-6xl px-4 sm:px-6">
        <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl">Board link</h2>
              <p className="text-sm text-muted">
                {usbReady
                  ? "Chrome or Edge can open the ESP32 USB port at 115200. The sketch answers u, d, p, and c."
                  : "USB serial appears after the page loads in Chrome or Edge. Other browsers cannot open the port."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {usbOn ? (
                <button type="button" onClick={() => void disconnectUsb()} className="h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg">Disconnect</button>
              ) : (
                <button type="button" onClick={() => void connectUsb()} disabled={!usbReady} className="h-11 rounded-full bg-ink px-4 text-sm font-medium text-bg disabled:opacity-40">Connect ESP32</button>
              )}
              <button type="button" disabled={!usbOn} onClick={() => void sendCmd("u")} className="h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40">Limit +5</button>
              <button type="button" disabled={!usbOn} onClick={() => void sendCmd("d")} className="h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40">Limit −5</button>
              <button type="button" disabled={!usbOn} onClick={() => void sendCmd("p")} className="h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40">Read flash</button>
              <button type="button" disabled={!usbOn} onClick={() => void sendCmd("c")} className="h-11 rounded-full border border-line px-4 text-sm disabled:opacity-40">Wipe flash</button>
            </div>
          </div>
          {usbError && <p className="mt-2 text-sm text-alert">{usbError}</p>}
          <p className="mt-3 text-sm text-muted">
            Last speed from the board: {boardSpeed == null ? "none yet" : `${boardSpeed.toFixed(1)} km/h`}. The big number above stays the desk simulation until the board prints an overspeed or a log line. Plug in the ESP32, then press Connect and choose its port.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-xl bg-chip p-3 font-mono text-xs leading-5 text-ink">
            {usbLines.length === 0 ? "No USB text yet." : usbLines.map((l) => `[${l.stamp}] ${l.text}`).join("\n")}
          </pre>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[1.4fr_0.8fr]">
        <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-muted">Fused speed</p>
              <p className={`font-display text-7xl leading-none ${worldView.over ? "text-alert" : "text-ink"}`}>
                {cut ? "—" : Math.round(worldView.fused)}
              </p>
              <p className="mt-1 text-sm text-muted">km/h shown to the gate sign</p>
            </div>
            <Status world={worldView} cut={cut} limit={limit} />
          </div>

          <Road carPct={carPct} inZone={worldView.inZone} cut={cut} />

          <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <Meter label="GPS" value={worldView.gpsOk ? worldView.gps.toFixed(1) : "lost"} hint={`${worldView.sats} sats · HDOP ${worldView.hdop.toFixed(1)}`} bad={!worldView.gpsOk} />
            <Meter label="Wheel" value={worldView.wheelOk && worldView.wheel > 0 ? worldView.wheel.toFixed(1) : worldView.wheelOk ? "idle" : "fault"} hint="Hall interrupt" bad={!worldView.wheelOk} />
            <Meter label="Truth" value={worldView.trueKmh.toFixed(1)} hint="hidden from the sign" bad={false} />
          </div>

          <div className="mt-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={samples}>
                <CartesianGrid stroke="#e3d9cb" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis width={28} tick={{ fill: "#6d655c", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#fffdf8", border: "1px solid #e3d9cb", borderRadius: 12, fontSize: 12 }}
                />
                <Line type="monotone" dataKey="gps" name="GPS" stroke="#6d655c" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="wheel" name="Wheel" stroke="#1f6b4a" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="fused" name="Fused" stroke="#c56a12" dot={false} strokeWidth={2.2} />
                <Line type="monotone" dataKey="limit" name="Limit" stroke="#b42318" dot={false} strokeDasharray="4 4" strokeWidth={1} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted">Amber is what the sign trusts. Grey GPS jumps; green wheel is tighter. The red dash is the live limit.</p>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl">Zone limit</h2>
              <p className="font-display text-3xl">{limit}</p>
            </div>
            <p className="text-sm text-muted">Inside the yellow band the safe yard limit is 20 km/h. Buttons step by 5, same as the gate hardware.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="h-11 flex-1 rounded-full bg-chip text-sm font-medium" onClick={() => setLimit((n) => Math.max(5, n - 5))}>−5</button>
              <button type="button" className="h-11 flex-1 rounded-full bg-ink text-sm font-medium text-bg" onClick={() => setLimit((n) => Math.min(80, n + 5))}>+5</button>
            </div>
            {worldView.inZone && limit !== 20 && (
              <button type="button" className="mt-3 h-11 w-full rounded-full bg-amber-soft text-sm font-medium text-amber" onClick={() => setLimit(20)}>
                Set yard limit to 20
              </button>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="font-display text-xl">Break a commercial unit</h2>
            <div className="mt-3 flex flex-col gap-2">
              <Fault
                on={faults.canopy}
                icon={<WifiOff size={16} />}
                title="Tree canopy"
                body="GPS sats fall under 4 beside the yard. Fusion keeps the wheel."
                toggle={() => setFaults((f) => ({ ...f, canopy: !f.canopy }))}
              />
              <Fault
                on={faults.wheelCut}
                icon={<Radio size={16} />}
                title="Wheel wire cut"
                body="If GPS still says the car is moving, the sign flags the sensor."
                toggle={() => setFaults((f) => ({ ...f, wheelCut: !f.wheelCut }))}
              />
              <Fault
                on={faults.radarGlare}
                icon={<AlertTriangle size={16} />}
                title="Slow queue"
                body="Cars crawl. A radar trailer often alarms; silence at a standstill does not."
                toggle={() => setFaults((f) => ({ ...f, radarGlare: !f.radarGlare }))}
              />
            </div>
          </section>
        </aside>

        <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-xl">Evidence log</h2>
              <p className="text-sm text-muted">{banner}</p>
            </div>
            <div className="flex gap-2 text-sm">
              <span className="rounded-full bg-chip px-3 py-2">{events} incidents</span>
              <span className="rounded-full bg-chip px-3 py-2">next #{resumed > seqRef.current ? resumed : seqSafe(slots)}</span>
              <button type="button" onClick={clearLog} className="rounded-full border border-line px-3 py-2">Clear log</button>
            </div>
          </div>
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Seq</th>
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">km/h</th>
                  <th className="py-2 pr-3 font-medium">Limit</th>
                  <th className="py-2 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 12).map((r) => (
                  <tr key={r.seq} className="border-t border-line">
                    <td className="py-2 pr-3">{r.seq}</td>
                    <td className="py-2 pr-3">{r.tSec}s</td>
                    <td className="py-2 pr-3">{r.speed.toFixed(1)}</td>
                    <td className="py-2 pr-3">{r.limit}</td>
                    <td className="py-2">
                      {r.flags.event ? "EVENT " : ""}
                      {r.flags.gpsOk ? "G" : "g!"} {r.flags.wheelOk ? "W" : "w!"} {r.flags.over ? "OVER" : ""}
                      {r.flags.noData ? " NO DATA" : ""}
                    </td>
                  </tr>
                ))}
                {records.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-muted">No records yet. Leave the street running for a second.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lg:col-span-2">
          <h2 className="font-display text-2xl">What current trackers still get wrong</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-5">
            {PROBLEMS.map((p) => (
              <article key={p.title} className="rounded-2xl border border-line bg-surface p-4">
                <h3 className="text-sm font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm text-muted">{p.body}</p>
              </article>
            ))}
          </div>
          <ul className="mt-4 grid gap-2 text-sm md:grid-cols-2">
            <Fix icon={<ShieldCheck size={16} />} text="No plates, no faces. Speed only, from the car’s own wheel and a GPS puck." />
            <Fix icon={<Gauge size={16} />} text="Kalman trusts the wheel when HDOP blows up, and trusts GPS when the wheel wire is quiet at a standstill." />
            <Fix icon={<Power size={16} />} text="Overspeed flushes immediately into a 40-slot ring. Boot scans sequence numbers and continues." />
            <Fix icon={<AlertTriangle size={16} />} text="If both sensors die, the sign shows 0 and NO SENSOR DATA instead of a stale speed." />
          </ul>
        </section>
      </div>
    </main>
  );
}

function seqSafe(slots: Array<LogRec | null>) {
  return scanResume(slots);
}

function Status({
  world,
  cut,
  limit,
}: {
  world: { over: boolean; noData: boolean; gpsOk: boolean; wheelOk: boolean; inZone: boolean };
  cut: boolean;
  limit: number;
}) {
  if (cut) return <Pill tone="alert">POWER LOST</Pill>;
  if (world.noData) return <Pill tone="alert">NO SENSOR DATA</Pill>;
  if (world.over) return <Pill tone="alert">OVER {limit}</Pill>;
  if (!world.gpsOk) return <Pill tone="amber">GPS LOST · wheel hold</Pill>;
  if (!world.wheelOk) return <Pill tone="amber">WHEEL SENSOR</Pill>;
  if (world.inZone) return <Pill tone="safe">IN YARD</Pill>;
  return <Pill tone="safe">CLEAR</Pill>;
}

function Pill({ children, tone }: { children: ReactNode; tone: "alert" | "amber" | "safe" }) {
  const cls =
    tone === "alert"
      ? "bg-alert-soft text-alert"
      : tone === "amber"
        ? "bg-amber-soft text-amber"
        : "bg-safe-soft text-safe";
  return <span className={`rounded-full px-3 py-2 text-xs font-semibold tracking-wide ${cls}`}>{children}</span>;
}

function Meter({ label, value, hint, bad }: { label: string; value: string; hint: string; bad: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2 ${bad ? "bg-alert-soft" : "bg-chip"}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="font-display text-2xl">{value}</p>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  );
}

function Road({ carPct, inZone, cut }: { carPct: number; inZone: boolean; cut: boolean }) {
  return (
    <div className="mt-5">
      <div className="relative h-16 overflow-hidden rounded-xl bg-chip">
        <div className="absolute inset-y-0 left-[47%] w-[21%] bg-amber-soft" />
        <div className="absolute left-3 top-2 text-xs text-muted">Approach</div>
        <div className="absolute left-[49%] top-2 text-xs font-medium text-amber">Yard</div>
        <div className="absolute right-3 top-2 text-xs text-muted">Exit</div>
        <div className="absolute inset-x-0 top-9 h-1 bg-line" />
        {!cut && (
          <div
            className="absolute top-6 size-5 rounded-sm bg-ink"
            style={{ left: `calc(${carPct}% - 10px)` }}
            aria-hidden
          />
        )}
      </div>
      <p className="mt-2 text-xs text-muted">{inZone ? "Car is inside the kindergarten band." : "Car is outside the band. Limit stays at the gate setting."}</p>
    </div>
  );
}

function Fault({
  on,
  icon,
  title,
  body,
  toggle,
}: {
  on: boolean;
  icon: ReactNode;
  title: string;
  body: string;
  toggle: () => void;
}) {
  return (
    <button type="button" onClick={toggle} className={`rounded-xl border px-3 py-3 text-left ${on ? "border-amber bg-amber-soft" : "border-line bg-surface"}`}>
      <span className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</span>
      <span className="mt-1 block text-xs text-muted">{body}</span>
    </button>
  );
}

function Fix({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <li className="flex gap-2 rounded-xl border border-line bg-surface px-3 py-3">
      <span className="mt-0.5 text-safe">{icon}</span>
      <span>{text}</span>
    </li>
  );
}
