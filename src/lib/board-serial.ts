export type SerialLine = { stamp: string; text: string };

type PortLike = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};

type SerialApi = {
  requestPort: () => Promise<PortLike>;
};

export function serialApi(): SerialApi | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { serial?: SerialApi };
  return nav.serial ?? null;
}

export function stampNow() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

export async function openBoard(baudRate = 115200): Promise<{
  port: PortLike;
  write: (text: string) => Promise<void>;
  read: (onLine: (line: string) => void, onClose: () => void) => Promise<void>;
  close: () => Promise<void>;
}> {
  const api = serialApi();
  if (!api) throw new Error("USB serial is only available in Chrome or Edge.");
  const port = await api.requestPort();
  await port.open({ baudRate });
  const encoder = new TextEncoder();
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  if (port.writable) writer = port.writable.getWriter();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let stopped = false;

  return {
    port,
    write: async (text: string) => {
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
      try { await reader?.cancel(); } catch { /* already closed */ }
      try { reader?.releaseLock(); } catch { /* released */ }
      try { writer?.releaseLock(); } catch { /* released */ }
      try { await port.close(); } catch { /* unplugged */ }
    },
  };
}
