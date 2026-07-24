#include <ArduinoJson.h>
#include <DFPlayerMini_Fast.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "dgus.h"
#include "qrcode.h"

// ==========================================
// CONFIGURATION (Adjust these as needed)
// ==========================================
#define WIFI_SSID "Freshpod"
#define WIFI_PASSWORD "passw0rd"

// Machine ID & Backend Config
#define MACHINE_ID "FP_MACHINE_01"
#define BACKEND_API_URL "https://www.hanish.coreblock.in/api/payment/create"
#define QR_AMOUNT 69.0f      // Payment amount in INR
#define QR_TIMEOUT_MS 180000 // 3 minutes timeout for scanning QR code

// Relay pins (Preserved from original code)
#define RELAY1 13 // Tissue Dispenser
#define RELAY2 12 // Door Lock
#define RELAY3 2  // Fogging
#define RELAY4 4  // UV Sterilization
#define RELAY5 18 // Thermal Sterilization
#define RELAY6 19 // Exhaust system
#define BUZZER 23 // Buzzer

// DFPlayer track numbers
#define TRACK_WELCOME 1
#define TRACK_PAYMENT_DONE 2
#define TRACK_DOOR_UNLOCKED 3
#define TRACK_DOOR_CLOSE 4
#define TRACK_UV_STERILIZATION 5
#define TRACK_UV_USES 6
#define TRACK_DRY_FOG 7
#define TRACK_DRY_FOG_USES 8
#define TRACK_THERMAL_DRYING 9
#define TRACK_THERMAL_DRYING_USES 10
#define TRACK_SANITIZING 11
#define TRACK_SANITIZED 12
#define TRACK_TISSUE_DISPENSED 13
#define TRACK_FRESHNESS 14
#define TRACK_THANK_YOU 15
#define TRACK_VISIT_AGAIN 16
#define TRACK_1MIN_TIME_REMAINDER 17
#define TRACK_30SEC_TIME_REMAINDER 18

// DWIN Serial Configuration
#define DWIN_RX_PIN 16
#define DWIN_TX_PIN 17

// ==========================================
// SYSTEM STATE DEFINITIONS
// ==========================================
enum MachineState {
  STATE_WELCOME,
  STATE_REQUEST_PAYMENT,
  STATE_WAIT_FOR_PAYMENT,
  STATE_CLEANING
};

MachineState currentState = STATE_WELCOME;
unsigned long stateTimer = 0;
unsigned long lastPollingTime = 0;

String currentQrId = "";
String currentUpiIntent = "";
bool paymentSuccessReceived = false;
bool qrPrefetched = false;

// Global objects
DFPlayerMini_Fast myMP3;
HardwareSerial dwinSerialPort(1);
WiFiClientSecure secureClient;
HTTPClient httpClient;

// Forward declarations
void startCleaningProcess();
void drawQRCode(const char *text);
bool requestNewPayment();
void pollPaymentStatus();
void connectWiFi();
void dgusShowLoadingIndicator();

void setup() {
  Serial.begin(9600);
  delay(1000);
  Serial.println("\n--- Freshpod ESP32 Boot Starting ---");

  // Set insecure mode on the global secure SSL client
  secureClient.setInsecure();

  // Initialize DWIN display
  dgusInit(dwinSerialPort, DWIN_RX_PIN, DWIN_TX_PIN, 115200);
  delay(100);
  dgusShowPage(
      12); // Show Screen 12 (Welcome/Calibration screen) during initialization
  delay(100);

  // Initialize DFPlayer
  if (!myMP3.begin(Serial)) {
    Serial.println("DFPlayer failed to start! Halting...");
    while (1)
      ;
  }
  myMP3.volume(80);

  // Initialize relays
  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);
  pinMode(RELAY3, OUTPUT);
  pinMode(RELAY4, OUTPUT);
  pinMode(RELAY5, OUTPUT);
  pinMode(RELAY6, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  // Initial relay states
  digitalWrite(RELAY1, LOW);
  digitalWrite(RELAY2, HIGH); // Closed/locked
  digitalWrite(RELAY3, LOW);
  digitalWrite(RELAY4, LOW);
  digitalWrite(RELAY5, LOW);
  digitalWrite(RELAY6, LOW);
  digitalWrite(BUZZER, LOW);

  // Connect to WiFi (while Screen 12 remains displayed)
  connectWiFi();

  // Start with Welcome screen (Screen 12)
  dgusShowPage(PAGE_WELCOME);
  myMP3.play(TRACK_WELCOME);
  stateTimer = millis();
  currentState = STATE_WELCOME;

  Serial.println("System initialized successfully (Direct API Polling Mode).");
}

void loop() {
  // Keep WiFi active
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  // State Machine logic
  switch (currentState) {

  case STATE_WELCOME:
    // Show welcome screen for 5 seconds, then transition to QR display request
    if (millis() - stateTimer >= 5000) {
      Serial.println("Transitioning to QR page, requesting payment details...");
      currentState = STATE_REQUEST_PAYMENT;
    }
    break;

  case STATE_REQUEST_PAYMENT:
    dgusShowPage(PAGE_QR_CODE);
    dgusClearQrArea(); // Clear the QR box to white during generation

    if (qrPrefetched) {
      Serial.println("[PREFETCH] Using pre-fetched payment QR code intent.");
      drawQRCode(currentUpiIntent.c_str());
      qrPrefetched = false; // Consume the prefetch
      paymentSuccessReceived = false;
      stateTimer = millis(); // Start payment timeout timer
      lastPollingTime = millis();
      currentState = STATE_WAIT_FOR_PAYMENT;
    } else if (requestNewPayment()) {
      Serial.println("QR generated successfully. Rendering...");
      drawQRCode(currentUpiIntent.c_str());
      paymentSuccessReceived = false;
      stateTimer = millis(); // Start payment timeout timer
      lastPollingTime = millis();
      currentState = STATE_WAIT_FOR_PAYMENT;
    } else {
      Serial.println(
          "[WARNING] Payment creation failed. Retrying in 5 seconds...");
      dgusShowLoadingIndicator();
      delay(5000);
      stateTimer = millis();
      // Keep state as STATE_REQUEST_PAYMENT to retry directly without flashing
      // the welcome page
    }
    break;

  case STATE_WAIT_FOR_PAYMENT:
    // 1. Check if payment succeeded (triggered by Polling status API)
    if (paymentSuccessReceived) {
      Serial.println(
          "Payment SUCCESS detected. Transitioning to cleaning sequence...");
      currentState = STATE_CLEANING;
      break;
    }

    // 2. Polling status from backend API directly (every 2 seconds)
    if (millis() - lastPollingTime >= 2000) {
      lastPollingTime = millis();
      pollPaymentStatus();
    }


    break;

  case STATE_CLEANING:
    // Run the detailed cleaning process (blocking sequence)
    startCleaningProcess();

    // Route state machine directly based on prefetch success
    stateTimer = millis();
    if (qrPrefetched) {
      Serial.println("[LOOP] QR was pre-drawn successfully. Entering STATE_WAIT_FOR_PAYMENT directly.");
      qrPrefetched = false; // Consume/reset prefetch flag
      paymentSuccessReceived = false;
      lastPollingTime = millis();
      currentState = STATE_WAIT_FOR_PAYMENT;
    } else {
      Serial.println("[LOOP] QR prefetch failed. Fallback to requesting payment synchronously.");
      currentState = STATE_REQUEST_PAYMENT;
    }
    break;
  }
}

// Draw the QR Code onto the DWIN Display (Optimized Horizontal Spans with RAM
// Buffering)
void drawQRCode(const char *text) {
  QRCode qrcode;
  // Version 4 QR Code with Low (L) Error Correction: 33x33 modules
  // This size holds up to 114 alphanumeric characters. The backend shortens the
  // UPI URL to ~70 characters to fit it.
  uint8_t qrcodeData[qrcode_getBufferSize(4)];

  Serial.print("[DEBUG] Initializing QR Code for: ");
  Serial.println(text);

  int result = qrcode_initText(&qrcode, qrcodeData, 4, ECC_LOW, text);
  if (result != 0) {
    Serial.println(
        "[ERROR] QR generation failed (text too long or version mismatch).");
    return;
  }

  // Placement math inside the 250x250 white box at X: 275, Y: 125
  // Size = 33 * 7 = 231 pixels. Margin = (250 - 231) / 2 = 9.5 pixels (9 pixels
  // used). Drawing starts at X = 284, Y = 134
  uint16_t startX = 284;
  uint16_t startY = 134;
  uint16_t moduleSize = 7;

  // Stack buffer to accumulate drawing data
  static DGUSRect spansBuffer[300];
  uint16_t spanCount = 0;

  for (uint8_t y = 0; y < qrcode.size; y++) {
    int runStart = -1;
    for (uint8_t x = 0; x < qrcode.size; x++) {
      bool isBlack = qrcode_getModule(&qrcode, x, y);

      if (isBlack) {
        if (runStart == -1) {
          runStart = x; // Start a new run of black modules
        }
      } else {
        if (runStart != -1) {
          if (spanCount < 300) {
            uint16_t xs = startX + runStart * moduleSize;
            uint16_t ys = startY + y * moduleSize;
            uint16_t xe = startX + x * moduleSize - 1;
            uint16_t ye = ys + moduleSize - 1;

            spansBuffer[spanCount++] = {xs, ys, xe, ye, COLOR_BLACK};
          }
          runStart = -1; // Reset run
        }
      }
    }

    // Draw run if it extends to the end of the row
    if (runStart != -1) {
      if (spanCount < 300) {
        uint16_t xs = startX + runStart * moduleSize;
        uint16_t ys = startY + y * moduleSize;
        uint16_t xe = startX + qrcode.size * moduleSize - 1;
        uint16_t ye = ys + moduleSize - 1;

        spansBuffer[spanCount++] = {xs, ys, xe, ye, COLOR_BLACK};
      }
    }
  }

  Serial.print("[DEBUG] Matrix scanned. Spans calculated: ");
  Serial.println(spanCount);

  // Clear the drawing area to white first
  dgusClearQrArea();
  delay(80); // Give the DWIN controller time to clear the screen

  // Draw all spans together via RAM buffering to prevent flicker and keep
  // drawings persistent
  dgusDrawRects(spansBuffer, spanCount);
  Serial.println("[DEBUG] DWIN rendering completed.");
}

// Clears the QR area and draws a loading progress bar inside the box
void dgusShowLoadingIndicator() {
  Serial.println("[DWIN] Drawing loading progress indicator to screen...");
  dgusClearQrArea();
  // Draw progress bar outline (X: 325 -> 475, Y: 240 -> 260)
  dgusDrawFilledRect(325, 240, 475, 260, COLOR_BLACK);
  dgusDrawFilledRect(327, 242, 473, 258, COLOR_WHITE);
  // Draw loading fill (Pastel steel blue color: 0x3186)
  dgusDrawFilledRect(332, 245, 400, 255, 0x3186);
}

// Call backend to create a dynamic QR Code session
bool requestNewPayment() {
  String url = BACKEND_API_URL;
  bool isHttps = url.startsWith("https://");

  bool beginSuccess = false;
  if (isHttps) {
    beginSuccess = httpClient.begin(secureClient, url);
  } else {
    WiFiClient client;
    beginSuccess = httpClient.begin(client, url);
  }

  if (!beginSuccess) {
    Serial.println("[ERROR] HTTP begin failed.");
    return false;
  }

  httpClient.addHeader("Content-Type", "application/json");

  // Note: amount is no longer sent; backend resolves it from its environment
  // variables
  DynamicJsonDocument doc(256);
  doc["machine_id"] = MACHINE_ID;

  String requestBody;
  serializeJson(doc, requestBody);

  Serial.print("[HTTP] Requesting QR details from: ");
  Serial.println(url);

  int httpResponseCode = httpClient.POST(requestBody);
  bool success = false;

  if (httpResponseCode == 200) {
    String responseString = httpClient.getString();
    Serial.println("[HTTP] Response received: " + responseString);
    DynamicJsonDocument respDoc(1024);
    DeserializationError error = deserializeJson(respDoc, responseString);

    if (!error) {
      currentQrId = respDoc["qr_id"].as<String>();
      currentUpiIntent = respDoc["upi_intent"].as<String>();
      Serial.println("[HTTP] Success! QR ID = " + currentQrId);
      success = true;
    } else {
      Serial.println("[ERROR] JSON Parsing failed: " + String(error.f_str()));
    }
  } else {
    Serial.print("[ERROR] HTTP request failed with code: ");
    Serial.println(httpResponseCode);
  }

  httpClient.end();
  return success;
}

// Polling status from API directly
void pollPaymentStatus() {
  if (currentQrId == "")
    return;

  String statusUrl = BACKEND_API_URL;
  statusUrl.replace("/create", "/status");
  statusUrl += "?qr_id=" + currentQrId;

  bool isHttps = statusUrl.startsWith("https://");

  bool beginSuccess = false;
  if (isHttps) {
    beginSuccess = httpClient.begin(secureClient, statusUrl);
  } else {
    WiFiClient client;
    beginSuccess = httpClient.begin(client, statusUrl);
  }

  if (!beginSuccess) {
    Serial.println("[ERROR] HTTP Poll begin failed.");
    return;
  }

  httpClient.addHeader("Connection", "keep-alive");

  Serial.print("[HTTP] Polling payment status: ");
  Serial.println(statusUrl);

  int httpResponseCode = httpClient.GET();

  if (httpResponseCode == 200) {
    String responseString = httpClient.getString();
    Serial.println("[HTTP] Status Response: " + responseString);
    DynamicJsonDocument doc(256);
    DeserializationError error = deserializeJson(doc, responseString);

    if (!error) {
      const char *status = doc["status"];
      if (status && String(status) == "paid") {
        Serial.println("[SUCCESS] Payment success detected via API polling!");
        paymentSuccessReceived = true;
      }
    } else {
      Serial.println("[ERROR] Failed to parse status JSON.");
    }
  } else {
    Serial.print("[ERROR] Status poll failed. Code: ");
    Serial.println(httpResponseCode);
  }

  httpClient.end();
}

// Connect to WiFi network
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED)
    return;

  Serial.print("[WIFI] Connecting to SSID: ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] Connected. IP Address: " +
                 WiFi.localIP().toString());

  // Buzzer beep for feedback
  digitalWrite(BUZZER, HIGH);
  delay(100);
  digitalWrite(BUZZER, LOW);
}

// Play out the full hardware sequence (preserved 100% from original code)
void startCleaningProcess() {
  Serial.println("=== STARTING CLEANING PROCESS ===");

  digitalWrite(BUZZER, HIGH);
  delay(500);
  digitalWrite(BUZZER, LOW);
  delay(250);
  digitalWrite(RELAY2, LOW);
  delay(500); // Door Unlock
  dgusShowPage(PAGE_PAYMENT_SUCCESS);
  delay(1000);
  myMP3.play(TRACK_PAYMENT_DONE);
  delay(7000);

  dgusShowPage(PAGE_DOOR_UNLOCKED);
  delay(1000);
  myMP3.play(TRACK_DOOR_UNLOCKED);
  delay(9000);

  dgusShowPage(PAGE_CLOSE_DOOR);
  delay(500);
  myMP3.play(TRACK_DOOR_CLOSE);
  delay(13000);

  digitalWrite(RELAY2, HIGH);
  delay(1000); // Close/lock the door
  dgusShowPage(PAGE_DUST_REMOVAL);
  delay(1000);
  digitalWrite(RELAY4, HIGH);
  delay(1000); // UV Light On
  digitalWrite(RELAY5, HIGH);
  delay(1000); // Initial Thermal System ON
  digitalWrite(RELAY3, HIGH);
  delay(1000); // Fogging Started
  myMP3.play(TRACK_UV_STERILIZATION);
  delay(8000);
  dgusShowPage(PAGE_UV_STERILIZATION);
  delay(1000);

  myMP3.play(TRACK_UV_USES);
  delay(21000);

  digitalWrite(RELAY5, LOW);
  delay(1000); // Initial Thermal system OFF
  dgusShowPage(PAGE_CLEANING_STARTED);
  delay(1000);
  myMP3.play(TRACK_DRY_FOG);
  delay(70000);

  myMP3.play(TRACK_DRY_FOG_USES);
  delay(58000);

  dgusShowPage(PAGE_SANITIZING);
  delay(1000);
  myMP3.play(TRACK_SANITIZING);
  delay(25000);

  digitalWrite(RELAY3, LOW);
  delay(500); // Fogging OFF
  digitalWrite(RELAY5, HIGH);
  delay(5000); // Thermal ON
  dgusShowPage(PAGE_DRY_HELMET);
  delay(500);
  myMP3.play(TRACK_THERMAL_DRYING);
  delay(16000);

  myMP3.play(TRACK_THERMAL_DRYING_USES);
  delay(26000);

  digitalWrite(RELAY1, HIGH);
  delay(15000); // Exhaust System ON
  myMP3.play(TRACK_30SEC_TIME_REMAINDER);
  delay(10000);
  digitalWrite(RELAY6, HIGH);
  delay(3000); // Tissue dispenser

  dgusShowPage(PAGE_HELMET_DISINFECTION);
  delay(1000);
  digitalWrite(RELAY5, LOW);
  delay(1000); // Thermal OFF
  digitalWrite(RELAY1, LOW);
  delay(500); // Exhaust System OFF
  digitalWrite(RELAY6, LOW);
  delay(1000);
  dgusShowPage(PAGE_TAKE_HELMET);
  delay(2000);
  digitalWrite(RELAY4, LOW);
  delay(1000); // UV OFF
  digitalWrite(RELAY2, LOW);
  delay(5000); // Door Unlock
  myMP3.play(TRACK_SANITIZED);
  delay(10000);

  dgusShowPage(PAGE_CLOSE_DOOR);
  delay(3500);
  digitalWrite(RELAY2, HIGH);
  delay(1000); // Lock door back up
  myMP3.play(TRACK_FRESHNESS);
  delay(12000);

  dgusShowPage(PAGE_THANK_YOU);
  delay(1000);
  myMP3.play(TRACK_THANK_YOU);

  // Prefetch the next payment QR link in the background during the static
  // "Thank You" screen display
  Serial.println("[PREFETCH] Prefetching next payment link from backend...");
  if (requestNewPayment()) {
    qrPrefetched = true;
    Serial.println("[PREFETCH] Success! QR code prefetched. Pre-drawing onto Page 0...");
    // Clear and draw the QR code on Page 0 in the background!
    dgusClearQrArea();
    drawQRCode(currentUpiIntent.c_str());
  } else {
    qrPrefetched = false;
    Serial.println(
        "[PREFETCH] Warning: prefetch failed. Will fetch synchronously later.");
  }

  delay(7000);

  Serial.println("=== CLEANING CYCLE COMPLETE ===");
  myMP3.play(TRACK_VISIT_AGAIN);
  delay(14000);
  dgusShowPage(PAGE_QR_CODE);

  // Reset all relays to safe default
  digitalWrite(RELAY1, LOW);
  delay(1000);
  digitalWrite(RELAY2, HIGH);
  delay(1000);
  digitalWrite(RELAY3, LOW);
  delay(1000);
  digitalWrite(RELAY4, LOW);
  delay(1000);
  digitalWrite(RELAY5, LOW);
  delay(1000);
  digitalWrite(RELAY6, LOW);
  delay(1000);
}
