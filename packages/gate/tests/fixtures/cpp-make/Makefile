# Fixture Makefile for the real C++ run: make test builds and runs one test program [C7].
# make test FAIL=1 compiles the failing check, so the run exits non-zero.
CXX ?= c++
DEFS = $(if $(FAIL),-DFAIL,)

.PHONY: test
test: calc_test
	./calc_test

calc_test: calc.cpp calc_test.cpp
	$(CXX) $(DEFS) -o calc_test calc.cpp calc_test.cpp
