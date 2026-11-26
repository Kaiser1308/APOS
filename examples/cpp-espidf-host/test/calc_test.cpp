#include <cassert>

int add(int a, int b) { return a + b; }

int main() { assert(add(1, 2) == 3); }
