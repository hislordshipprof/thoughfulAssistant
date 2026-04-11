#include "wasapi_capture.h"
#include "utils.h"
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <vector>
#include <cmath>
#include <cstring>

namespace WasapiCapture {

static std::atomic<bool> g_capturing{false};
static std::thread g_loopbackThread;
static std::thread g_micThread;
static Napi::ThreadSafeFunction g_loopbackTsfn;
static Napi::ThreadSafeFunction g_micTsfn;

struct AudioChunk {
  std::vector<int16_t> samples;
  int sampleRate;
  int channels;
  bool isLoopback;
};

// Resample to 24kHz mono 16-bit PCM (required by OpenAI Realtime API)
static std::vector<int16_t> ResampleToMono24k(
  const float* input, UINT32 frameCount,
  int srcRate, int srcChannels
) {
  double ratio = 24000.0 / srcRate;
  UINT32 outFrames = static_cast<UINT32>(frameCount * ratio);
  std::vector<int16_t> output(outFrames);

  for (UINT32 i = 0; i < outFrames; i++) {
    double srcPos = i / ratio;
    UINT32 srcIdx = static_cast<UINT32>(srcPos);
    if (srcIdx >= frameCount) srcIdx = frameCount - 1;

    // Mix all channels to mono
    float sample = 0.0f;
    for (int ch = 0; ch < srcChannels; ch++) {
      sample += input[srcIdx * srcChannels + ch];
    }
    sample /= srcChannels;

    // Convert to 16-bit
    int32_t s = static_cast<int32_t>(sample * 32767.0f);
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    output[i] = static_cast<int16_t>(s);
  }

  return output;
}

static void CaptureThreadProc(Napi::ThreadSafeFunction tsfn, bool isLoopback) {
  HRESULT hr;

  hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    tsfn.Release();
    return;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(
    __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
    __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator)
  );
  if (FAILED(hr)) {
    CoUninitialize();
    tsfn.Release();
    return;
  }

  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(
    isLoopback ? eRender : eCapture,
    eConsole,
    &device
  );
  if (FAILED(hr)) {
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  IAudioClient* audioClient = nullptr;
  hr = device->Activate(
    __uuidof(IAudioClient), CLSCTX_ALL,
    nullptr, reinterpret_cast<void**>(&audioClient)
  );
  if (FAILED(hr)) {
    device->Release();
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = audioClient->GetMixFormat(&mixFormat);
  if (FAILED(hr)) {
    audioClient->Release();
    device->Release();
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  DWORD streamFlags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  if (isLoopback) {
    streamFlags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
  }

  REFERENCE_TIME bufferDuration = 200000; // 20ms in 100ns units
  hr = audioClient->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    streamFlags,
    bufferDuration,
    0,
    mixFormat,
    nullptr
  );
  if (FAILED(hr)) {
    CoTaskMemFree(mixFormat);
    audioClient->Release();
    device->Release();
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  IAudioCaptureClient* captureClient = nullptr;
  hr = audioClient->GetService(
    __uuidof(IAudioCaptureClient),
    reinterpret_cast<void**>(&captureClient)
  );
  if (FAILED(hr)) {
    CoTaskMemFree(mixFormat);
    audioClient->Release();
    device->Release();
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  HANDLE captureEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  audioClient->SetEventHandle(captureEvent);

  // Use MMCSS for pro audio priority
  DWORD taskIndex = 0;
  HANDLE mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  hr = audioClient->Start();
  if (FAILED(hr)) {
    if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
    CloseHandle(captureEvent);
    captureClient->Release();
    CoTaskMemFree(mixFormat);
    audioClient->Release();
    device->Release();
    enumerator->Release();
    CoUninitialize();
    tsfn.Release();
    return;
  }

  int srcRate = mixFormat->nSamplesPerSec;
  int srcChannels = mixFormat->nChannels;
  bool isFloat = (mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ||
    (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
     reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mixFormat)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);

  while (g_capturing) {
    DWORD waitResult = WaitForSingleObject(captureEvent, 100);
    if (!g_capturing) break;

    if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_TIMEOUT) {
      UINT32 packetLength = 0;
      hr = captureClient->GetNextPacketSize(&packetLength);

      while (SUCCEEDED(hr) && packetLength > 0 && g_capturing) {
        BYTE* data = nullptr;
        UINT32 numFrames = 0;
        DWORD flags = 0;

        hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
        if (SUCCEEDED(hr) && numFrames > 0) {
          std::vector<int16_t> resampled;

          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            // Insert silence
            UINT32 outFrames = static_cast<UINT32>(numFrames * (24000.0 / srcRate));
            resampled.resize(outFrames, 0);
          } else if (isFloat) {
            resampled = ResampleToMono24k(
              reinterpret_cast<const float*>(data),
              numFrames, srcRate, srcChannels
            );
          } else {
            // Convert 16-bit PCM to float first
            const int16_t* pcm = reinterpret_cast<const int16_t*>(data);
            std::vector<float> floatData(numFrames * srcChannels);
            for (UINT32 i = 0; i < numFrames * srcChannels; i++) {
              floatData[i] = pcm[i] / 32768.0f;
            }
            resampled = ResampleToMono24k(floatData.data(), numFrames, srcRate, srcChannels);
          }

          if (!resampled.empty()) {
            AudioChunk* chunk = nullptr;
            try {
              chunk = new AudioChunk{
                std::move(resampled), 24000, 1, isLoopback
              };
            } catch (const std::bad_alloc&) {
              // OOM — skip this chunk rather than crashing the thread
              captureClient->ReleaseBuffer(numFrames);
              hr = captureClient->GetNextPacketSize(&packetLength);
              continue;
            }

            tsfn.NonBlockingCall(chunk, [](Napi::Env env, Napi::Function callback, AudioChunk* chunk) {
              auto buffer = Napi::Buffer<int16_t>::Copy(
                env, chunk->samples.data(), chunk->samples.size()
              );
              auto obj = Napi::Object::New(env);
              obj.Set("samples", buffer);
              obj.Set("sampleRate", Napi::Number::New(env, chunk->sampleRate));
              obj.Set("channels", Napi::Number::New(env, chunk->channels));
              obj.Set("isLoopback", Napi::Boolean::New(env, chunk->isLoopback));
              callback.Call({obj});
              delete chunk;
            });
          }

          captureClient->ReleaseBuffer(numFrames);
        }

        hr = captureClient->GetNextPacketSize(&packetLength);
      }
    }
  }

  audioClient->Stop();
  if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
  CloseHandle(captureEvent);
  captureClient->Release();
  CoTaskMemFree(mixFormat);
  audioClient->Release();
  device->Release();
  enumerator->Release();
  CoUninitialize();
  tsfn.Release();
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_capturing) {
    return Napi::Boolean::New(env, true);
  }

  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected two callback functions (loopback, mic)").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_capturing = true;

  g_loopbackTsfn = Napi::ThreadSafeFunction::New(
    env, info[0].As<Napi::Function>(),
    "LoopbackAudioCallback", 0, 1
  );

  g_micTsfn = Napi::ThreadSafeFunction::New(
    env, info[1].As<Napi::Function>(),
    "MicAudioCallback", 0, 1
  );

  g_loopbackThread = std::thread(CaptureThreadProc, g_loopbackTsfn, true);
  g_micThread = std::thread(CaptureThreadProc, g_micTsfn, false);

  g_loopbackThread.detach();
  g_micThread.detach();

  return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  g_capturing = false;
  return Napi::Boolean::New(env, true);
}

Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_capturing.load());
}

Napi::Value GetCaptureDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Array::New(env);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return result;

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(
    __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
    __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator)
  );
  if (FAILED(hr)) { CoUninitialize(); return result; }

  IMMDeviceCollection* collection = nullptr;
  hr = enumerator->EnumAudioEndpoints(eAll, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(hr)) { enumerator->Release(); CoUninitialize(); return result; }

  UINT count = 0;
  collection->GetCount(&count);

  for (UINT i = 0; i < count; i++) {
    IMMDevice* device = nullptr;
    if (SUCCEEDED(collection->Item(i, &device))) {
      IPropertyStore* props = nullptr;
      if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
        PROPVARIANT name;
        PropVariantInit(&name);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &name))) {
          auto obj = Napi::Object::New(env);
          obj.Set("name", Napi::String::New(env, Utils::WideToUtf8(name.pwszVal)));

          LPWSTR deviceId = nullptr;
          if (SUCCEEDED(device->GetId(&deviceId))) {
            obj.Set("id", Napi::String::New(env, Utils::WideToUtf8(deviceId)));
            CoTaskMemFree(deviceId);
          }

          result.Set(result.Length(), obj);
          PropVariantClear(&name);
        }
        props->Release();
      }
      device->Release();
    }
  }

  collection->Release();
  enumerator->Release();
  CoUninitialize();

  return result;
}

} // namespace WasapiCapture
