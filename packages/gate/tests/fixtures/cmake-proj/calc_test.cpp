// Fixture test program: exits non-zero when its check fails; the calc_fail target compiles the wrong expectation [C7].
int add(int a, int b) { return a + b; }

int main() {
#ifdef FAIL
  return add(2, 2) == 5 ? 0 : 1;
#else
  return add(2, 2) == 4 ? 0 : 1;
#endif
}
