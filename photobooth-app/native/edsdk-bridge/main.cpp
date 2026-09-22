/**
 * Minimal Canon EDSDK bridge for photobooth (live view frame + host save capture).
 * Build with CMake against EDSDK_64 from Canon (Library/EDSDK.lib, copy Dll next to exe).
 * Protocol: one JSON object per line on stdin; one JSON response per line on stdout.
 *
 * Commands:
 *  {"cmd":"init"}
 *  {"cmd":"list"}
 *  {"cmd":"open","index":0}
 *  {"cmd":"preview","path":"C:/temp/live.jpg"}
 *  {"cmd":"capture","path":"C:/Capture/shot.jpg"}
 *  {"cmd":"close"}
 *  {"cmd":"shutdown"}
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#include "EDSDK.h"
#include "EDSDKTypes.h"

namespace fs = std::filesystem;
using namespace std::chrono_literals;

static EdsCameraRef g_camera = nullptr;
static bool g_sdk = false;
static bool g_session = false;
static std::mutex g_capMtx;
static std::condition_variable g_capCv;
static bool g_captureDone = false;
static EdsError g_captureErr = EDS_ERR_OK;
static std::string g_capturePath;
static EdsDirectoryItemRef g_pendingDirItem = nullptr;
static bool g_shouldExit = false;

/** Live view stays open across preview frames (do not start/stop EVF every tick — that caps FPS). */
static bool g_evfLive = false;
static EdsUInt32 g_evfOrgDevice = 0;

static bool writeFileBinary(const char* filename, const void* data, size_t len) {
  std::ofstream f(filename, std::ios::binary);
  if (!f) return false;
  f.write(static_cast<const char*>(data), static_cast<std::streamsize>(len));
  return static_cast<bool>(f);
}

static bool startEvfMode() {
  EdsUInt32 evfMode = 0;
  EdsError err = EdsGetPropertyData(g_camera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode);
  if (err != EDS_ERR_OK) return false;
  if (evfMode == 0) {
    evfMode = 1;
    err = EdsSetPropertyData(g_camera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode);
  }
  return err == EDS_ERR_OK;
}

static void stopEvfLive() {
  if (!g_camera) {
    g_evfLive = false;
    return;
  }
  if (!g_evfLive) return;

  EdsUInt32 device = 0;
  if (EdsGetPropertyData(g_camera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device) == EDS_ERR_OK) {
    device &= ~kEdsEvfOutputDevice_PC;
    EdsSetPropertyData(g_camera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
  }
  EdsUInt32 evfMode = 0;
  if (EdsGetPropertyData(g_camera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode) == EDS_ERR_OK && evfMode != 0) {
    evfMode = 0;
    EdsSetPropertyData(g_camera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode);
  }
  g_evfLive = false;
}

/** Enable EVF + PC output once; kept hot until stopEvfLive() or session close. */
static bool ensureEvfLive() {
  if (!g_camera) return false;
  if (g_evfLive) return true;

  if (!startEvfMode()) return false;

  EdsError err = EdsGetPropertyData(g_camera, kEdsPropID_Evf_OutputDevice, 0, sizeof(g_evfOrgDevice), &g_evfOrgDevice);
  EdsUInt32 device = g_evfOrgDevice | kEdsEvfOutputDevice_PC;
  if (err == EDS_ERR_OK) err = EdsSetPropertyData(g_camera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
  if (err != EDS_ERR_OK) return false;

  std::this_thread::sleep_for(80ms);
  g_evfLive = true;
  return true;
}

/** One EVF frame into JPEG file — memory stream + EdsDownloadEvfImage (Canon sample pattern). */
static bool pullEvfFrameToFile(const char* filename) {
  if (!ensureEvfLive()) return false;

  EdsStreamRef stream = nullptr;
  EdsEvfImageRef evfImage = nullptr;
  const EdsUInt32 kBuf = 4u * 1024u * 1024u;

  EdsError err = EdsCreateMemoryStream(kBuf, &stream);
  if (err == EDS_ERR_OK) err = EdsCreateEvfImageRef(stream, &evfImage);
  if (err != EDS_ERR_OK) {
    if (stream) EdsRelease(stream);
    return false;
  }

  err = EdsDownloadEvfImage(g_camera, evfImage);
  for (int i = 0; i < 12 && err == EDS_ERR_OBJECT_NOTREADY; i++) {
    EdsGetEvent();
    std::this_thread::sleep_for(1ms);
    err = EdsDownloadEvfImage(g_camera, evfImage);
  }

  bool ok = false;
  if (err == EDS_ERR_OK) {
    EdsUInt64 length = 0;
    void* ptr = nullptr;
    if (EdsGetLength(stream, &length) == EDS_ERR_OK && EdsGetPointer(stream, &ptr) == EDS_ERR_OK && ptr && length > 0) {
      fs::path out(filename);
      if (out.has_parent_path()) {
        std::error_code ec;
        fs::create_directories(out.parent_path(), ec);
      }
      ok = writeFileBinary(filename, ptr, static_cast<size_t>(length));
    }
  }

  if (evfImage) EdsRelease(evfImage);
  if (stream) EdsRelease(stream);
  return ok;
}

static void replyJson(const std::string& s) {
  std::cout << s << std::endl;
}

static std::string jsonEscape(const std::string& in) {
  std::string o;
  for (char c : in) {
    if (c == '\\' || c == '"') o += '\\';
    o += c;
  }
  return o;
}

static std::string jsonStringVal(const std::string& j, const char* key) {
  std::string k = std::string("\"") + key + "\":\"";
  size_t p = j.find(k);
  if (p == std::string::npos) return "";
  p += k.size();
  size_t e = j.find('"', p);
  if (e == std::string::npos) return "";
  return j.substr(p, e - p);
}

static int jsonIntVal(const std::string& j, const char* key) {
  std::string k = std::string("\"") + key + "\":";
  size_t p = j.find(k);
  if (p == std::string::npos) return 0;
  p += k.size();
  while (p < j.size() && (j[p] == ' ' || j[p] == '\t')) p++;
  return (int)strtol(j.c_str() + p, nullptr, 10);
}

static EdsError EDSCALLBACK onObjectEvent(EdsObjectEvent event, EdsBaseRef object, EdsVoid* context) {
  (void)context;
  if (event != kEdsObjectEvent_DirItemRequestTransfer && event != kEdsObjectEvent_DirItemCreated) {
    if (object) EdsRelease(object);
    return EDS_ERR_OK;
  }
  if (object) {
    EdsRetain(object);
    std::lock_guard<std::mutex> lk(g_capMtx);
    if (g_pendingDirItem) {
      EdsRelease(g_pendingDirItem);
      g_pendingDirItem = nullptr;
    }
    g_pendingDirItem = (EdsDirectoryItemRef)object;
  }
  g_capCv.notify_one();
  if (object) EdsRelease(object);
  return EDS_ERR_OK;
}

static EdsError downloadPendingCaptureToPath(const std::string& targetPath) {
  EdsDirectoryItemRef item = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_capMtx);
    item = g_pendingDirItem;
    g_pendingDirItem = nullptr;
  }
  if (!item) return EDS_ERR_OBJECT_NOTREADY;

  EdsError err = EDS_ERR_OK;
  EdsStreamRef stream = nullptr;
  EdsDirectoryItemInfo dirItemInfo = {};

  err = EdsGetDirectoryItemInfo(item, &dirItemInfo);
  if (err == EDS_ERR_OK) {
    err = EdsCreateFileStream(targetPath.c_str(), kEdsFileCreateDisposition_CreateAlways, kEdsAccess_ReadWrite, &stream);
  }
  if (err == EDS_ERR_OK) err = EdsDownload(item, dirItemInfo.size, stream);
  if (err == EDS_ERR_OK) err = EdsDownloadComplete(item);

  if (stream) {
    EdsRelease(stream);
    stream = nullptr;
  }
  EdsRelease(item);
  return err;
}

static bool openSession() {
  if (!g_camera) return false;
  EdsError err = EdsOpenSession(g_camera);
  if (err != EDS_ERR_OK) return false;

  EdsUInt32 saveTo = kEdsSaveTo_Host;
  err = EdsSetPropertyData(g_camera, kEdsPropID_SaveTo, 0, sizeof(saveTo), &saveTo);
  if (err != EDS_ERR_OK) {
    EdsCloseSession(g_camera);
    return false;
  }

  EdsCapacity capacity = {0x7FFFFFFF, 0x1000, 1};
  err = EdsSetCapacity(g_camera, capacity);
  if (err != EDS_ERR_OK) {
    EdsCloseSession(g_camera);
    return false;
  }

  err = EdsSetObjectEventHandler(g_camera, kEdsObjectEvent_All, onObjectEvent, nullptr);
  if (err != EDS_ERR_OK) {
    EdsCloseSession(g_camera);
    return false;
  }

  g_session = true;
  return true;
}

static void closeSession() {
  if (!g_camera || !g_session) return;
  stopEvfLive();
  EdsSetObjectEventHandler(g_camera, kEdsObjectEvent_All, nullptr, nullptr);
  {
    std::lock_guard<std::mutex> lk(g_capMtx);
    if (g_pendingDirItem) {
      EdsRelease(g_pendingDirItem);
      g_pendingDirItem = nullptr;
    }
  }
  EdsCloseSession(g_camera);
  g_session = false;
}

static bool takePictureToHost() {
  EdsError err = EdsSendCommand(g_camera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_Completely_NonAF);
  if (err != EDS_ERR_OK) {
    EdsSendCommand(g_camera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_OFF);
    return false;
  }
  err = EdsSendCommand(g_camera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_OFF);
  return err == EDS_ERR_OK;
}

static std::string handleLine(const std::string& line) {
  if (line.empty()) return "{\"ok\":false,\"err\":-1,\"msg\":\"empty\"}";

  const std::string cmd = jsonStringVal(line, "cmd");
  if (cmd.empty()) return "{\"ok\":false,\"err\":-1,\"msg\":\"no cmd\"}";

  if (cmd == "init") {
    if (g_sdk) return "{\"ok\":true}";
    EdsError err = EdsInitializeSDK();
    if (err != EDS_ERR_OK) {
      char b[128];
      snprintf(b, sizeof(b), "{\"ok\":false,\"err\":%d,\"msg\":\"EdsInitializeSDK\"}", (int)err);
      return b;
    }
    std::this_thread::sleep_for(800ms);
    g_sdk = true;
    return "{\"ok\":true}";
  }

  if (cmd == "list") {
    if (!g_sdk) return "{\"ok\":false,\"err\":-2,\"msg\":\"not initialized\"}";
    EdsCameraListRef list = nullptr;
    EdsError err = EdsGetCameraList(&list);
    if (err != EDS_ERR_OK) {
      char b[128];
      snprintf(b, sizeof(b), "{\"ok\":false,\"err\":%d}", (int)err);
      return b;
    }
    EdsUInt32 count = 0;
    err = EdsGetChildCount(list, &count);
    std::string names = "[";
    for (EdsUInt32 i = 0; i < count && err == EDS_ERR_OK; i++) {
      EdsCameraRef cam = nullptr;
      err = EdsGetChildAtIndex(list, i, &cam);
      if (err != EDS_ERR_OK || !cam) continue;
      EdsDeviceInfo inf = {};
      if (EdsGetDeviceInfo(cam, &inf) == EDS_ERR_OK) {
        if (i) names += ",";
        names += "\"";
        names += jsonEscape(inf.szDeviceDescription);
        names += "\"";
      }
      EdsRelease(cam);
    }
    names += "]";
    EdsRelease(list);
    return std::string("{\"ok\":true,\"cameras\":") + names + "}";
  }

  if (cmd == "open") {
    if (!g_sdk) return "{\"ok\":false,\"err\":-2,\"msg\":\"not initialized\"}";
    int idx = jsonIntVal(line, "index");
    if (g_camera) {
      closeSession();
      EdsRelease(g_camera);
      g_camera = nullptr;
    }
    EdsCameraListRef list = nullptr;
    EdsError err = EdsGetCameraList(&list);
    if (err != EDS_ERR_OK) return "{\"ok\":false,\"err\":-3}";
    EdsUInt32 count = 0;
    EdsGetChildCount(list, &count);
    if (idx < 0 || (EdsUInt32)idx >= count) {
      EdsRelease(list);
      return "{\"ok\":false,\"err\":-4,\"msg\":\"bad index\"}";
    }
    err = EdsGetChildAtIndex(list, idx, &g_camera);
    EdsRelease(list);
    if (err != EDS_ERR_OK || !g_camera) return "{\"ok\":false,\"err\":-5}";
    if (!openSession()) return "{\"ok\":false,\"err\":-6,\"msg\":\"session\"}";
    return "{\"ok\":true}";
  }

  if (cmd == "preview") {
    if (!g_session || !g_camera) return "{\"ok\":false,\"err\":-7,\"msg\":\"no session\"}";
    std::string p = jsonStringVal(line, "path");
    if (p.empty()) return "{\"ok\":false,\"err\":-8,\"msg\":\"path\"}";
    EdsGetEvent();
    bool ok = pullEvfFrameToFile(p.c_str());
    if (!ok) return "{\"ok\":false,\"err\":-9,\"msg\":\"evf\"}";
    return std::string("{\"ok\":true,\"path\":\"") + jsonEscape(p) + "\"}";
  }

  if (cmd == "capture") {
    if (!g_session || !g_camera) return "{\"ok\":false,\"err\":-7,\"msg\":\"no session\"}";
    std::string p = jsonStringVal(line, "path");
    if (p.empty()) return "{\"ok\":false,\"err\":-8,\"msg\":\"path\"}";
    if (p.find('\\') != std::string::npos) {
      std::replace(p.begin(), p.end(), '\\', '/');
    }
    fs::path out(p);
    if (out.has_parent_path()) {
      std::error_code ec;
      fs::create_directories(out.parent_path(), ec);
    }

    stopEvfLive();
    EdsGetEvent();

    {
      std::lock_guard<std::mutex> lk(g_capMtx);
      g_capturePath = p;
      g_captureDone = false;
      g_captureErr = EDS_ERR_OK;
      if (g_pendingDirItem) {
        EdsRelease(g_pendingDirItem);
        g_pendingDirItem = nullptr;
      }
    }
    if (!takePictureToHost()) {
      return "{\"ok\":false,\"err\":-10,\"msg\":\"shutter\"}";
    }

    const auto deadline = std::chrono::steady_clock::now() + 45s;
    while (std::chrono::steady_clock::now() < deadline) {
      EdsGetEvent();
      EdsError dlErr = downloadPendingCaptureToPath(p);
      if (dlErr == EDS_ERR_OK) {
        g_captureErr = EDS_ERR_OK;
        g_captureDone = true;
        break;
      }
      std::unique_lock<std::mutex> lk(g_capMtx);
      g_capCv.wait_for(lk, 150ms);
    }
    if (!g_captureDone) {
      return "{\"ok\":false,\"err\":-11,\"msg\":\"timeout\"}";
    }
    EdsError er = g_captureErr;
    g_capturePath.clear();
    if (er != EDS_ERR_OK) {
      char b[160];
      snprintf(b, sizeof(b), "{\"ok\":false,\"err\":%d,\"msg\":\"download\"}", (int)er);
      return b;
    }
    return std::string("{\"ok\":true,\"path\":\"") + jsonEscape(p) + "\"}";
  }

  if (cmd == "close") {
    closeSession();
    if (g_camera) {
      EdsRelease(g_camera);
      g_camera = nullptr;
    }
    return "{\"ok\":true}";
  }

  if (cmd == "shutdown") {
    closeSession();
    if (g_camera) {
      EdsRelease(g_camera);
      g_camera = nullptr;
    }
    if (g_sdk) {
      EdsTerminateSDK();
      g_sdk = false;
    }
    g_shouldExit = true;
    return "{\"ok\":true}";
  }

  return "{\"ok\":false,\"err\":-99,\"msg\":\"unknown cmd\"}";
}

int main() {
  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "exit") break;
    g_shouldExit = false;
    std::string out = handleLine(line);
    replyJson(out);
    if (g_shouldExit) break;
  }

  closeSession();
  if (g_camera) {
    EdsRelease(g_camera);
    g_camera = nullptr;
  }
  if (g_sdk) {
    EdsTerminateSDK();
    g_sdk = false;
  }
  return 0;
}
