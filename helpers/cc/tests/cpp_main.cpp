// Self test for the C++ template API.
//
// Build and run with:  bash helpers/cc/build_and_test.sh

#include "../exploring_collections.h"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <limits>
#include <sstream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <tuple>
#include <vector>

namespace {

int failures = 0;

void check(const std::string &name, bool condition, const std::string &detail = std::string()) {
  if (condition) {
    return;
  }
  ++failures;
  std::cout << "  FAIL " << name;
  if (!detail.empty()) {
    std::cout << ": " << detail;
  }
  std::cout << "\n";
}

void check_contains(const std::string &name, const std::string &haystack, const std::string &needle) {
  check(name, haystack.find(needle) != std::string::npos,
        "expected to find [" + needle + "] in " + haystack);
}

/**
 * Structural sanity check: quotes must be balanced and the braces/brackets must
 * nest properly once string literals are skipped.
 */
bool is_structurally_valid(const std::string &json) {
  int depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (char character : json) {
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        in_string = false;
      }
      continue;
    }
    switch (character) {
      case '"':
        in_string = true;
        break;
      case '{':
      case '[':
        ++depth;
        break;
      case '}':
      case ']':
        --depth;
        if (depth < 0) {
          return false;
        }
        break;
      default:
        break;
    }
  }
  return depth == 0 && !in_string;
}

struct Temperature {
  std::string city;
  int degree_celsius;
  double humidity;
  bool raining;
};

/** Streamable but without EC_OBJECT: reported as a single string cell. */
struct Streamable {
  int value;
};

std::ostream &operator<<(std::ostream &stream, const Streamable &value) {
  return stream << "Streamable(" << value.value << ")";
}

}  // namespace

EC_OBJECT(Temperature, city, degree_celsius, humidity, raining)

int main() {
  const std::vector<Temperature> temperatures = {
      {"Seoul", 21, 55.5, false},
      {"Lima", 19, 70.25, true},
  };

  const std::string payload = exploring_collections::dump_json(temperatures);
  check("valid structure", is_structurally_valid(payload), payload);
  check_contains("envelope", payload, "\"__ec\":1");
  check_contains("kind", payload, "\"kind\":\"sequence\"");
  check_contains("total", payload, "\"total\":2");
  check_contains("field name", payload, "\"city\"");
  check_contains("string value", payload, "\"Seoul\"");
  check_contains("number value", payload, "\"degree_celsius\":21");
  check_contains("double value", payload, "\"humidity\":55.5");
  check_contains("bool value", payload, "\"raining\":false");

  // Mapping: entries are reported as [key, value] pairs.
  const std::map<std::string, int> lookup = {{"Seoul", 21}, {"Lima", 19}};
  const std::string mapping = exploring_collections::dump_json(lookup);
  check("mapping kind", is_structurally_valid(mapping), mapping);
  check_contains("mapping envelope", mapping, "\"kind\":\"mapping\"");
  check_contains("mapping pair", mapping, "[\"Lima\",19]");

  // Nested containers.
  const std::vector<std::vector<int>> matrix = {{1, 2}, {3}};
  const std::string nested = exploring_collections::dump_json(matrix);
  check("nested structure", is_structurally_valid(nested), nested);
  check_contains("nested inner", nested, "[1,2]");

  const std::map<std::string, std::vector<int>> grouped = {{"a", {1, 2, 3}}};
  const std::string grouped_json = exploring_collections::dump_json(grouped);
  check_contains("map of vectors", grouped_json, "[\"a\",[1,2,3]]");

  // Optional, pair, tuple, set.
  const std::optional<int> missing;
  const std::string missing_json = exploring_collections::dump_json(missing);
  check_contains("optional empty", missing_json, "[null]");
  const std::optional<int> present = 7;
  check_contains("optional present", exploring_collections::dump_json(present), "[7]");
  check_contains("pair", exploring_collections::dump_json(std::make_pair(1, std::string("a"))), "[1,\"a\"]");
  check_contains("tuple", exploring_collections::dump_json(std::make_tuple(1, 2, 3)), "[1,2,3]");
  const std::set<int> unique = {3, 1, 2};
  check_contains("set is a sequence", exploring_collections::dump_json(unique), "\"kind\":\"sequence\"");
  check_contains("set values", exploring_collections::dump_json(unique), "[1,2,3]");

  // C arrays keep their length.
  const int numbers[4] = {10, 20, 30, 40};
  const std::string array_json = exploring_collections::dump_json(numbers);
  check_contains("c array kind", array_json, "\"kind\":\"sequence\"");
  check_contains("c array total", array_json, "\"total\":4");
  check_contains("c array items", array_json, "[10,20,30,40]");

  // Special floating point values.
  const std::vector<double> specials = {std::nan(""), std::numeric_limits<double>::infinity(),
                                        -std::numeric_limits<double>::infinity(), 1.5};
  const std::string specials_json = exploring_collections::dump_json(specials);
  check_contains("nan", specials_json, "\"NaN\"");
  check_contains("infinity", specials_json, "\"Infinity\"");
  check_contains("negative infinity", specials_json, "\"-Infinity\"");

  // Escaping.
  const std::vector<std::string> texts = {"quote\"backslash\\newline\n", "üñïçødé", "<html>&"};
  const std::string texts_json = exploring_collections::dump_json(texts);
  check("escaping keeps the payload valid", is_structurally_valid(texts_json), texts_json);
  check_contains("escaped quote", texts_json, "quote\\\"backslash\\\\newline\\n");
  check_contains("unicode preserved", texts_json, "üñïçødé");
  check_contains("html not escaped", texts_json, "<html>&");

  // Record mode for a single struct.
  const Temperature single{"Seoul", 21, 55.5, false};
  const std::string single_json = exploring_collections::dump_json(single);
  check_contains("record kind", single_json, "\"kind\":\"record\"");
  check_contains("record total", single_json, "\"total\":1");

  // Limits.
  exploring_collections::Limits limits;
  limits.max_items = 2;
  const std::string limited = exploring_collections::dump_json_with_limits(std::vector<int>{1, 2, 3, 4}, limits);
  check_contains("max items", limited, "[1,2]");
  check_contains("total is not limited", limited, "\"total\":4");

  limits.max_items = 200000;
  limits.max_depth = 1;
  const std::string shallow = exploring_collections::dump_json_with_limits(matrix, limits);
  check_contains("max depth", shallow, "<max depth>");

  // The debugger entry point returns a stable C string.
  const char *cursor = exploring_collections::dump_json_cstr(temperatures);
  check("cstr is not null", cursor != nullptr);
  check("cstr content", std::string(cursor).find("Seoul") != std::string::npos, std::string(cursor));

  // Types without EC_OBJECT fall back to a streamed string when possible.
  const std::string streamed_json = exploring_collections::dump_json(Streamable{5});
  check_contains("streamed fallback", streamed_json, "\"Streamable(5)\"");

  std::cout << (failures == 0 ? "cpp helper: all checks passed\n"
                              : "cpp helper: " + std::to_string(failures) + " failure(s)\n");
  return failures == 0 ? 0 : 1;
}
