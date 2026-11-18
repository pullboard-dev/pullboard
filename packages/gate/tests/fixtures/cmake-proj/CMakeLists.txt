# Fixture project for the real CMake and CTest run: one passing and one failing add_test [C7].
cmake_minimum_required(VERSION 3.10)
project(calc_fixture CXX)
enable_testing()

add_executable(calc_pass calc_test.cpp)
add_executable(calc_fail calc_test.cpp)
target_compile_definitions(calc_fail PRIVATE FAIL)

add_test(NAME calc_passes COMMAND calc_pass)
add_test(NAME calc_fails COMMAND calc_fail)
