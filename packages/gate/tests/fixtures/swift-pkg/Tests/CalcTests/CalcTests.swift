import XCTest
@testable import Calc

final class CalcTests: XCTestCase {
    func testPasses() { XCTAssertEqual(add(2, 3), 5) }
    func testFails() { XCTAssertEqual(add(2, 3), 6) }
}
