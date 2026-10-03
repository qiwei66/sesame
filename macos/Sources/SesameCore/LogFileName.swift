import Foundation

/// Which log file a build writes to. Builds with `-DSESAME_TEST_HOOKS` write `sesame-test.log`
/// so test runs never mix into the real `sesame.log`.
public enum LogFileName {
    public static let release = "sesame.log"
    public static let test = "sesame-test.log"
    public static func name(testHooks: Bool) -> String { testHooks ? test : release }
}
