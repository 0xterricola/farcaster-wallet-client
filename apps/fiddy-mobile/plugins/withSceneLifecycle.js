/**
 * Adopt the UIScene lifecycle, which apps built with the iOS 27 SDK must do or
 * they are stopped at launch by
 * `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` (TN3187).
 *
 * Expo SDK 55's prebuild template still starts React Native from
 * `didFinishLaunchingWithOptions` and ships no `UIApplicationSceneManifest`, so
 * this plugin closes that gap until the SDK (58+ has it built in) does:
 *
 *  1. `Info.plist` gets `UIApplicationSceneManifest` naming
 *     `$(PRODUCT_MODULE_NAME).SceneDelegate`.
 *  2. `AppDelegate.swift` stops creating the window, keeps the factory, and
 *     gains `startReactNative(in:)` for the scene to call.
 *  3. `SceneDelegate` is declared in the same file (so no Xcode project surgery
 *     is needed to add a new source file to the target) and hands URL events
 *     back to the app delegate.
 *
 * Idempotent: a second run finds `class SceneDelegate` and the trimmed delegate
 * and changes nothing.
 */

const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const WINDOW_START_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const SCENE_AWARE_START = `// The window is created and React Native is started by \`SceneDelegate\`: the
    // iOS 27 SDK requires the scene-based life cycle (TN3187), and an app that
    // keeps starting its window here is stopped at launch with
    // \`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption\`.
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  /// Called by \`SceneDelegate\` once UIKit has connected the window scene.
  func startReactNative(
    in window: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) {
    self.window = window
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)`;

const SCENE_DELEGATE = `

/// The scene-based life cycle, which apps built with the iOS 27 SDK must adopt.
///
/// Declared in this file rather than a new \`SceneDelegate.swift\` so the class is
/// in the app target without editing the Xcode project: \`Info.plist\` names it as
/// \`$(PRODUCT_MODULE_NAME).SceneDelegate\`.
@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.startReactNative(in: window)

    // A launch URL (\`fiddy://…\`) arrives on the scene, not the application.
    if let url = connectionOptions.urlContexts.first?.url {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard
      let url = URLContexts.first?.url,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else { return }
    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }
}
`;

const withSceneManifest = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });

const withSceneDelegate = (config) =>
  withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        'withSceneLifecycle expects the Swift AppDelegate template (Expo SDK 55+).',
      );
    }
    let contents = cfg.modResults.contents;
    if (contents.includes('class SceneDelegate')) {
      return cfg;
    }
    if (!contents.includes(WINDOW_START_BLOCK)) {
      throw new Error(
        'withSceneLifecycle could not find the legacy window-start block in AppDelegate.swift — the Expo template changed. Update the plugin instead of shipping a launch crash.',
      );
    }
    contents = contents.replace(WINDOW_START_BLOCK, SCENE_AWARE_START);
    cfg.modResults.contents = `${contents}${SCENE_DELEGATE}`;
    return cfg;
  });

module.exports = (config) => withSceneDelegate(withSceneManifest(config));