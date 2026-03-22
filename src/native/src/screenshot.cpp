#include "screenshot.h"
#include <windows.h>
#include <gdiplus.h>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")

namespace {

// GDI+ initialization (one-time)
static bool gGdiplusInit = false;
static ULONG_PTR gGdiplusToken = 0;

void ensureGdiplus() {
  if (!gGdiplusInit) {
    Gdiplus::GdiplusStartupInput input;
    Gdiplus::GdiplusStartup(&gGdiplusToken, &input, nullptr);
    gGdiplusInit = true;
  }
}

// Find the JPEG encoder CLSID
bool getJpegEncoderClsid(CLSID* clsid) {
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (size == 0) return false;

  std::vector<uint8_t> buf(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
  Gdiplus::GetImageEncoders(num, size, encoders);

  for (UINT i = 0; i < num; i++) {
    if (wcscmp(encoders[i].MimeType, L"image/jpeg") == 0) {
      *clsid = encoders[i].Clsid;
      return true;
    }
  }
  return false;
}

// Base64 encoding
static const char kBase64Table[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t n = ((uint32_t)data[i]) << 16;
    if (i + 1 < len) n |= ((uint32_t)data[i+1]) << 8;
    if (i + 2 < len) n |= data[i+2];
    out.push_back(kBase64Table[(n >> 18) & 63]);
    out.push_back(kBase64Table[(n >> 12) & 63]);
    out.push_back(i + 1 < len ? kBase64Table[(n >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? kBase64Table[n & 63] : '=');
  }
  return out;
}

} // anonymous namespace

Napi::Value Screenshot::CaptureScreen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  ensureGdiplus();

  LARGE_INTEGER freq, t0, t1, t2, t3;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t0);

  // Get primary screen dimensions
  int screenW = GetSystemMetrics(SM_CXSCREEN);
  int screenH = GetSystemMetrics(SM_CYSCREEN);

  // Create compatible DC and bitmap for BitBlt
  HDC hdcScreen = GetDC(NULL);
  HDC hdcMem = CreateCompatibleDC(hdcScreen);
  HBITMAP hBitmap = CreateCompatibleBitmap(hdcScreen, screenW, screenH);
  HGDIOBJ hOld = SelectObject(hdcMem, hBitmap);

  // BitBlt — the actual screen capture
  BitBlt(hdcMem, 0, 0, screenW, screenH, hdcScreen, 0, 0, SRCCOPY);

  QueryPerformanceCounter(&t1);

  // Create GDI+ Bitmap from HBITMAP
  Gdiplus::Bitmap* bitmap = Gdiplus::Bitmap::FromHBITMAP(hBitmap, NULL);

  // Encode to JPEG in memory using IStream
  IStream* stream = nullptr;
  CreateStreamOnHGlobal(NULL, TRUE, &stream);

  CLSID jpegClsid;
  getJpegEncoderClsid(&jpegClsid);

  // JPEG quality = 80 (good balance of size vs quality for screen captures)
  Gdiplus::EncoderParameters encoderParams;
  encoderParams.Count = 1;
  encoderParams.Parameter[0].Guid = Gdiplus::EncoderQuality;
  encoderParams.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  encoderParams.Parameter[0].NumberOfValues = 1;
  ULONG quality = 80;
  encoderParams.Parameter[0].Value = &quality;

  bitmap->Save(stream, &jpegClsid, &encoderParams);

  QueryPerformanceCounter(&t2);

  // Read stream contents
  STATSTG stats;
  stream->Stat(&stats, STATFLAG_NONAME);
  size_t jpegSize = (size_t)stats.cbSize.QuadPart;

  LARGE_INTEGER seekPos;
  seekPos.QuadPart = 0;
  stream->Seek(seekPos, STREAM_SEEK_SET, nullptr);

  std::vector<uint8_t> jpegData(jpegSize);
  ULONG bytesRead = 0;
  stream->Read(jpegData.data(), (ULONG)jpegSize, &bytesRead);

  // Base64 encode
  std::string b64 = base64Encode(jpegData.data(), jpegSize);
  std::string dataUrl = "data:image/jpeg;base64," + b64;

  QueryPerformanceCounter(&t3);

  // Cleanup
  stream->Release();
  delete bitmap;
  SelectObject(hdcMem, hOld);
  DeleteObject(hBitmap);
  DeleteDC(hdcMem);
  ReleaseDC(NULL, hdcScreen);

  double msBitBlt  = (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart;
  double msEncode  = (double)(t2.QuadPart - t1.QuadPart) * 1000.0 / freq.QuadPart;
  double msBase64  = (double)(t3.QuadPart - t2.QuadPart) * 1000.0 / freq.QuadPart;
  double msTotal   = (double)(t3.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart;

  // Return result object
  auto result = Napi::Object::New(env);
  result.Set("dataUrl", Napi::String::New(env, dataUrl));
  result.Set("width", Napi::Number::New(env, screenW));
  result.Set("height", Napi::Number::New(env, screenH));
  result.Set("jpegSize", Napi::Number::New(env, (double)jpegSize));
  result.Set("msBitBlt", Napi::Number::New(env, msBitBlt));
  result.Set("msEncode", Napi::Number::New(env, msEncode));
  result.Set("msBase64", Napi::Number::New(env, msBase64));
  result.Set("msTotal", Napi::Number::New(env, msTotal));

  return result;
}
