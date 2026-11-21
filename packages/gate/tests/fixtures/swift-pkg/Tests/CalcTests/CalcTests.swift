import Calc

#if canImport(Testing)
import Testing

@Test func testPasses() { #expect(Calc.add(2, 3) == 5) }
@Test func testFails() { #expect(Calc.add(2, 3) == 6) }
#else
import XCTest

final class CalcTests: XCTestCase {
    func testPasses() { XCTAssertEqual(Calc.add(2, 3), 5) }
    func testFails() { XCTAssertEqual(Calc.add(2, 3), 6) }
}
#endif
