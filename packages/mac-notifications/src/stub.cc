// Off macOS there is no per-app notification permission to read.
#include <napi.h>

static Napi::Value GetStatus(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "unsupported");
}

static Napi::Value Request(const Napi::CallbackInfo& info) { return info.Env().Undefined(); }

static Napi::Value BundleId(const Napi::CallbackInfo& info) { return info.Env().Null(); }

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("bundleId", Napi::Function::New(env, BundleId));
  exports.Set("getStatus", Napi::Function::New(env, GetStatus));
  exports.Set("request", Napi::Function::New(env, Request));
  return exports;
}

NODE_API_MODULE(mac_notifications, Init)
