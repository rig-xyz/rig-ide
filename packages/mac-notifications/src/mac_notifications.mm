// Reads and requests this app's notification permission through
// UNUserNotificationCenter, the API macOS keeps the per-app switch in
// (System Settings › Notifications). Must run inside an app bundle
// (Electron's main process); a bare `node` process has no bundle and the
// center throws, so the JS wrapper only loads this in Electron on macOS.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <napi.h>

static const char* StatusName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusNotDetermined: return "notDetermined";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

// Blocks for the settings callback (it answers in milliseconds, off the
// main thread), capped at 2 s so a stuck daemon can't hang the app.
static Napi::Value GetStatus(const Napi::CallbackInfo& info) {
  __block UNAuthorizationStatus status = UNAuthorizationStatusNotDetermined;
  __block BOOL answered = NO;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[UNUserNotificationCenter currentNotificationCenter]
      getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
        status = settings.authorizationStatus;
        answered = YES;
        dispatch_semaphore_signal(done);
      }];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return Napi::String::New(info.Env(), answered ? StatusName(status) : "unknown");
}

// Shows macOS's own prompt (only ever once per app; afterwards it answers
// at once with the stored choice). Fire and forget: callers re-read the
// status when the window regains focus.
static Napi::Value Request(const Napi::CallbackInfo& info) {
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
                                       UNAuthorizationOptionBadge)
                    completionHandler:^(BOOL granted, NSError* error){
                    }];
  return info.Env().Undefined();
}

// This process's bundle id: what System Settings › Notifications lists the
// app under (Rig's own when packaged, Electron's in development).
static Napi::Value BundleId(const Napi::CallbackInfo& info) {
  NSString* bundleId = [[NSBundle mainBundle] bundleIdentifier];
  if (!bundleId) return info.Env().Null();
  return Napi::String::New(info.Env(), [bundleId UTF8String]);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("bundleId", Napi::Function::New(env, BundleId));
  exports.Set("getStatus", Napi::Function::New(env, GetStatus));
  exports.Set("request", Napi::Function::New(env, Request));
  return exports;
}

NODE_API_MODULE(mac_notifications, Init)
