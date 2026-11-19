// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "Calc",
    targets: [
        .target(name: "Calc"),
        .testTarget(name: "CalcTests", dependencies: ["Calc"]),
    ]
)
