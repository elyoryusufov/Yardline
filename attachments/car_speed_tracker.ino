/*
 * Car Speed Tracker - Embedded Prototype (ESP32)
 * ------------------------------------------------
 *  - GPS speed (NEO-6M via UART, TinyGPSPlus)
 *  - Hall wheel-speed sensor via HARDWARE INTERRUPT
 *  - Kalman fusion of GPS + wheel speed
 *  - Power-loss-safe logging: RAM-cached circular buffer -> flash commit
 *  - Fully non-blocking (async task scheduler, no delay())
 *  - Failsafes: GPS fix loss, wheel-sensor disconnect, total data loss
 *
 * Test without hardware: run gps_simulator.py on your PC and feed the ESP32's
 * Serial2 with the generated NMEA (or wire GPS TX to a USB-TTL adapter).
 */

#include <TinyGPSPlus.h>
#include <EEPROM.h>
#define USE_DISPLAY 1
#if USE_DISPLAY
  #include <Wire.h>
  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
#endif

// ----------------------------- Pin map ------------------------------------
#define PIN_WHEEL      4      // Hall sensor OUT (interrupt-capable, pull-up)
#define PIN_BTN_UP     26     // limit +5  (active LOW, to GND)
#define PIN_BTN_DOWN   27     // limit -5  (active LOW, to GND)
#define PIN_SDA        21     // OLED
#define PIN_SCL        22     // OLED
#define GPS_RX_PIN     16     // ESP32 RX  <-  GPS TX
#define GPS_TX_PIN     17     // ESP32 TX  ->  GPS RX (optional)

// --------------------------- Calibration ----------------------------------
const float WHEEL_CIRC_M      = 2.00f;   // 2 * pi * wheel radius [m]
const float PULSES_PER_REV    = 1.0f;    // magnets per wheel (ABS: teeth count)
const float LIMIT_STEP_KMH    = 5.0f;
float       speedLimitKmh     = 30.0f;   // adjustable at runtime

// ------------------------- Task periods [ms] -------------------------------
const uint32_t GPS_PUMP_MS    = 10;      // feed the NMEA parser
const uint32_t COMPUTE_MS     = 500;     // speed + fusion + failsafes
const uint32_t DISPLAY_MS     = 200;     // OLED refresh (fixed rate, no flicker)
const uint32_t FLUSH_MS       = 10000;   // flash commit interval
const uint32_t BUTTON_MS      = 50;      // debounce poll

// --------------------------- Failsafe limits -------------------------------
const uint8_t  MIN_SATS       = 4;
const uint32_t GPS_MAX_AGE_MS = 1500;
const float    MAX_HOP        = 8.0f;
const uint32_t WHEEL_TIMEOUT_MS = 1500;  // no pulse this long => sensor fault
const float    MOVING_KMH     = 3.0f;    // above this, wheel must produce pulses

// ========================== 1. KALMAN FILTER ===============================
// Scalar constant-speed Kalman: smooths noisy GPS and jumpy sensor data.
class Kalman1D {
public:
  Kalman1D(float q, float r) : x(0), p(1000), q(q), r(r) {}
  void predict(uint32_t dtMs) { p += q * (dtMs / 1000.0f); }
  void update(float z, float measR) {
    float k = p / (p + measR);
    x += k * (z - x);
    p *= (1.0f - k);
  }
  float value() const { return x; }
  void reset(float v) { x = v; p = 1000; }
private:
  float x, p, q, r;
};

// GPS noise adapts to signal quality: shaky fix -> trust it less.
float gpsNoiseR(float hdop) { return 4.0f + hdop * hdop; }

// ==================== 2. WHEEL SPEED: HARDWARE INTERRUPT ===================
// Interrupts count every pulse; nothing blocks the main loop, so no pulse is
// missed even at high speed (polled digitalRead() WOULD miss pulses).
volatile uint32_t pulseCount   = 0;
volatile uint32_t lastPulseMs  = 0;

void IRAM_ATTR onWheelPulse() {           // IRAM_ATTR: keep ISR in fast memory
  pulseCount++;
  lastPulseMs = millis();
}

// ==================== 3. POWER-SAFE LOG BUFFER (EEPROM) ======================
// Records live in the emulated-EEPROM RAM cache; flash is committed sparingly
// (every FLUSH_MS, or IMMEDIATELY when an overspeed event occurs so evidence
// survives a sudden power cut). Boot scan recovers the write position after
// power loss via per-slot sequence numbers.
struct LogRec {                 // 12 bytes
  uint32_t seq;                 // monotonically increasing
  uint16_t speedX10;            // 0.1 km/h resolution
  uint16_t flags;               // bit0 GPS_OK bit1 WHEEL_OK bit2 OVER
                                // bit3 EVENT bit4 GPS_WARN bit5 WHEEL_WARN
  uint32_t timeSec;             // uptime seconds (use RTC/NTP in production)
};
const uint8_t  SLOT_COUNT  = 40;                    // 40*12 = 480B + header
const uint16_t EEPROM_SIZE = 512;

uint32_t nextSeq  = 1;
bool     logDirty = false;

// crash-safe resume: a slot is valid only if its seq wraps to its index
void logScanOnBoot() {
  uint32_t best = 0;
  for (uint8_t i = 0; i < SLOT_COUNT; i++) {
    LogRec r;
    EEPROM.get(sizeof(uint32_t) + i * sizeof(LogRec), r);
    if (r.seq > best && (r.seq % SLOT_COUNT) == i) best = r.seq;
  }
  nextSeq = best + 1;
  Serial.printf("[LOG] resumed at seq=%lu (%lu records on disk)\n", nextSeq, best);
}

void logWrite(float speedKmh, uint16_t flags) {
  LogRec r{ nextSeq, (uint16_t)(speedKmh * 10.0f), flags,
            (uint32_t)(millis() / 1000) };
  EEPROM.put(sizeof(uint32_t) + (nextSeq % SLOT_COUNT) * sizeof(LogRec), r);
  nextSeq++;
  logDirty = true;
}

void logFlush() {
  if (logDirty && EEPROM.commit()) logDirty = false;   // flash written here
}

void logPrintAll() {
  for (uint8_t i = 0; i < SLOT_COUNT; i++) {
    LogRec r; EEPROM.get(sizeof(uint32_t) + i * sizeof(LogRec), r);
    if (r.seq == 0 || (r.seq % SLOT_COUNT) != i) continue;   // empty/corrupt
    Serial.printf("#%lu  %lus  %.1f km/h  flags=0x%02X\n",
                  r.seq, r.timeSec, r.speedX10 / 10.0f, r.flags);
  }
}

void logClear() {
  for (uint8_t i = 0; i < SLOT_COUNT; i++) {
    LogRec r{0,0,0,0};
    EEPROM.put(sizeof(uint32_t) + i * sizeof(LogRec), r);
  }
  logFlush(); nextSeq = 1;
  Serial.println("[LOG] cleared.");
}

// ============================ Shared state =================================
TinyGPSPlus gps;
Kalman1D    speedKf(0.8f, 4.0f);          // process noise, base meas noise
float       fusedKmh = 0, wheelKmh = 0, gpsKmh = 0;
bool        gpsOk = false, wheelOk = false, overSpeed = false;

uint32_t tGps = 0, tCompute = 0, tDisplay = 0, tFlush = 0, tButton = 0;

// ============================ SETUP =========================================
#if USE_DISPLAY
Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool displayOk = false;
#endif

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Car Speed Tracker prototype ===");

  pinMode(PIN_WHEEL, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_WHEEL), onWheelPulse, RISING);

  pinMode(PIN_BTN_UP, INPUT_PULLUP);
  pinMode(PIN_BTN_DOWN, INPUT_PULLUP);

  Serial2.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  EEPROM.begin(EEPROM_SIZE);
  logScanOnBoot();

  #if USE_DISPLAY
    Wire.begin(PIN_SDA, PIN_SCL);
    displayOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
    if (!displayOk) Serial.println("[WARN] OLED not found - serial output only.");
  #endif
}

// ============================ GPS PUMP TASK ================================
void gpsPump() {
  while (Serial2.available()) gps.encode(Serial2.read());
}

// ==================== 4/5. COMPUTE TASK: SPEED + FAILSAFES ==================
void computeTask() {
  uint32_t now  = millis();
  uint32_t dtMs = now - tCompute;

  // ---- wheel speed from interrupt counts ----
  static uint32_t lastPulseCount = 0;
  uint32_t pulses;
  noInterrupts(); pulses = pulseCount; interrupts();   // atomic snapshot
  uint32_t delta = pulses - lastPulseCount;
  lastPulseCount = pulses;

  wheelKmh = (delta * (WHEEL_CIRC_M / PULSES_PER_REV) / (dtMs / 1000.0f)) * 3.6f;
  bool wheelFresh = (now - lastPulseMs) < WHEEL_TIMEOUT_MS;

  // ---- FAILSAFE #1: satellite drop / fix loss ----
  gpsOk = gps.location.isValid()
          && (gps.location.age() < GPS_MAX_AGE_MS)
          && gps.satellites.isValid()
          && (gps.satellites.value() >= MIN_SATS)
          && (!gps.hdop.isValid() || gps.hdop.hdop() < MAX_HOP);
  gpsKmh = gpsOk ? gps.speed.kmph() : fusedKmh;   // hold last value if stale

  // ---- FAILSAFE #2: wheel sensor disconnected ----
  // GPS says we are moving but the wheel line is silent => sensor/wiring gone.
  // At a standstill, silence is normal - do not alarm then.
  wheelOk = wheelFresh || (gpsOk && gpsKmh < MOVING_KMH);

  // ---- Kalman fusion (measurement gating makes it failsafe-aware) ----
  speedKf.predict(dtMs);
  if (gpsOk)                 speedKf.update(gpsKmh, gpsNoiseR(gps.hdop.hdop()));
  if (wheelOk && wheelFresh) speedKf.update(wheelKmh, 1.0f);  // wheel: tight noise
  fusedKmh = speedKf.value();

  bool noData = !gpsOk && !wheelOk;   // FAILSAFE #3 handled at display/logging

  // ---- overspeed event (edge-triggered; logs + flushes immediately) ----
  bool over = fusedKmh > speedLimitKmh;
  uint16_t flags = (gpsOk<<0) | (wheelOk<<1) | (over<<2)
                 | ((!gpsOk)<<4) | ((!wheelOk)<<5);
  if (over && !overSpeed) {                 // rising edge = incident begins
    flags |= (1<<3);                        // EVENT bit
    logWrite(fusedKmh, flags);
    logFlush();                             // commit NOW: power cut can't
    Serial.printf("[EVENT] OVERSPEED %.1f km/h (limit %.0f)\n",
                  fusedKmh, speedLimitKmh); // erase the evidence
  }
  overSpeed = over;

  // ---- periodic 1 Hz logging ----
  static uint32_t last1Hz = 0;
  if (now - last1Hz >= 1000) { last1Hz = now; logWrite(noData ? 0 : fusedKmh, flags); }

  tCompute = now;
}

// ============================ DISPLAY TASK =================================
#if USE_DISPLAY
void displayTask() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  bool noData = !gpsOk && !wheelOk;
  float shown = noData ? 0.0f : fusedKmh;   // FAILSAFE #3: zero + warning

  display.setTextSize(3);                   // big speed digits
  display.setCursor(0, 14);
  display.printf("%.0f", shown);

  display.setTextSize(1);
  display.setCursor(100, 20); display.print("km/h");
  display.setCursor(0, 44);
  display.printf("LIM %.0f  %s%s", speedLimitKmh,
                 gpsOk ? "G" : "-", wheelOk ? "W" : "-");

  display.setCursor(0, 0);
  if (noData)        display.print("! NO SENSOR DATA");
  else if (!gpsOk)   display.print("! GPS LOST");
  else if (!wheelOk) display.print("! WHEEL SENSOR");
  if (overSpeed) { display.setCursor(70, 0); display.print("OVER!"); }

  display.display();                        // fixed-rate refresh: no flicker
}
#endif

// ============================ BUTTON TASK ==================================
void buttonTask() {
  static bool lastUp = true, lastDown = true;
  bool up   = digitalRead(PIN_BTN_UP);
  bool down = digitalRead(PIN_BTN_DOWN);
  if (lastUp && !up)     { speedLimitKmh += LIMIT_STEP_KMH;
                           Serial.printf("Limit -> %.0f\n", speedLimitKmh); }
  if (lastDown && !down) { speedLimitKmh = max(5.0f, speedLimitKmh - LIMIT_STEP_KMH);
                           Serial.printf("Limit -> %.0f\n", speedLimitKmh); }
  lastUp = up; lastDown = down;
}

// ============================ SERIAL COMMANDS ==============================
void serialCommands() {
  if (!Serial.available()) return;
  char c = Serial.read();
  switch (c) {
    case 'u': speedLimitKmh += LIMIT_STEP_KMH; break;
    case 'd': speedLimitKmh = max(5.0f, speedLimitKmh - LIMIT_STEP_KMH); break;
    case 'p': logPrintAll(); break;
    case 'c': logClear(); break;
    case '?': Serial.println("u/d=limit  p=print log  c=clear log"); break;
  }
}

// ============================ MAIN LOOP (all async) ========================
void loop() {
  uint32_t now = millis();

  if (now - tGps    >= GPS_PUMP_MS) { tGps    = now; gpsPump(); }
  if (now - tCompute >= COMPUTE_MS) { computeTask(); }          // sets tCompute
  if (now - tDisplay >= DISPLAY_MS) { tDisplay = now;
                                      #if USE_DISPLAY
                                        if (displayOk) displayTask();
                                      #endif
                                    }
  if (now - tButton >= BUTTON_MS)   { tButton  = now; buttonTask(); }
  if (now - tFlush  >= FLUSH_MS)    { tFlush   = now; logFlush(); }
  serialCommands();
}
