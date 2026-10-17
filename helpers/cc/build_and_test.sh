#!/usr/bin/env bash
# Compiles and runs the C and C++ helper self tests.
#
#   bash helpers/cc/build_and_test.sh
#
# Requires gcc/g++ (or clang) with C99 and C++17 support.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="${here}/build"
mkdir -p "${build}"

cc="${CC:-gcc}"
cxx="${CXX:-g++}"

echo "== C++ template API =="
"${cxx}" -std=c++17 -O1 -Wall -Wextra -o "${build}/cpp_test" "${here}/tests/cpp_main.cpp"
"${build}/cpp_test"

echo
echo "== C API (compiled as C99, linked with the C++ implementation) =="
"${cc}" -std=c99 -O1 -Wall -Wextra -c "${here}/tests/c_main.c" -o "${build}/c_main.o"
"${cxx}" -std=c++17 -O1 -Wall -Wextra -c "${here}/exploring_collections.cpp" -o "${build}/c_impl.o"
"${cxx}" "${build}/c_main.o" "${build}/c_impl.o" -o "${build}/c_test"
"${build}/c_test"

echo
echo "cc helpers: ok"
