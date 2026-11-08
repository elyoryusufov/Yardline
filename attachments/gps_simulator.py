#!/usr/bin/env python3
"""gps_simulator.py - desk-test the ESP32 tracker without a car or GPS module.

Feeds realistic NMEA-0183 (RMC + GGA) over a serial port at 1 Hz:
  - speed profile: 0 -> 70 -> 0 km/h with noise (watch the Kalman smooth it)
  - every ~35 s: 6 s of GPS blackout (watch the failsafe kick in)
  - optional: --no-wheel equivalent is tested by leaving PIN_WHEEL unconnected

Usage:
  pip install pyserial
  python gps_simulator.py --port COM5          (Windows)
  python gps_simulator.py --port /dev/ttyUSB0  (Linux/Mac)
Connect: simulator TX -> ESP32 GPIO16 (GPS_RX_PIN), GND common.
"""
import argparse, time, math, random, datetime
import serial

def nmea(sentence_body: str) -> bytes:
    cks = 0
    for ch in sentence_body:
        cks ^= ord(ch)
    return f"${sentence_body}*{cks:02X}\r\n".encode()

def build_rmc(t, lat, lon, speed_kmh, course):
    ts = t.strftime("%H%M%S")
    ds = t.strftime("%d%m%y")
    knots = speed_kmh / 1.852
    return nmea(f"GPRMC,{ts},A,{lat:.4f},N,{lon:.4f},E,"
                f"{knots:.2f},{course:.1f},{ds},,A")

def build_gga(t, lat, lon, sats, hdop):
    ts = t.strftime("%H%M%S")
    return nmea(f"GPGGA,{ts},{lat:.4f},N,{lon:.4f},E,1,{sats:02d},"
                f"{hdop:.1f},50.0,M,,M,,")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--baud", type=int, default=9600)
    args = ap.parse_args()

    ser = serial.Serial(args.port, args.baud, timeout=1)
    lat0, lon0 = 59.4370, 24.7536          # Tallinn - adjust anywhere
    start = time.time()
    print(f"Streaming NMEA to {args.port}. Ctrl+C to stop.")

    while True:
        el = time.time() - start
        # speed profile: accelerate to ~70, hold, decelerate; 30s period
        base = 35 * (1 + math.sin(el * 2 * math.pi / 30.0))
        speed = max(0.0, base + random.gauss(0, 1.5))   # noisy raw GPS speed

        # GPS blackout every ~35 s for 6 s -> tests failsafe
        in_blackout = (el % 35.0) > 29.0
        sats  = 3 if in_blackout else random.randint(7, 12)
        hdop  = 7.5 if in_blackout else random.uniform(0.9, 1.6)

        lat = lat0 + math.sin(el / 120.0) * 0.01
        lon = lon0 + el * 0.00002

        now = datetime.datetime.utcnow()
        ser.write(build_rmc(now, lat, lon, 0 if in_blackout else speed, 90.0))
        ser.write(build_gga(now, lat, lon, sats, hdop))
        time.sleep(1.0)

if __name__ == "__main__":
    main()
