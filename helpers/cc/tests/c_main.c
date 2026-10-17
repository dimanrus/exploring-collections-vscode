/*
 * Self test for the C API.
 * Build and run with: bash helpers/cc/build_and_test.sh
 */

#include "../exploring_collections.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;

static void check(const char *name, int condition) {
  if (condition) {
    return;
  }
  ++failures;
  printf("  FAIL %s\n", name);
}

static void check_contains(const char *name, const char *haystack, const char *needle) {
  if (haystack != NULL && strstr(haystack, needle) != NULL) {
    return;
  }
  ++failures;
  printf("  FAIL %s: expected [%s] in [%s]\n", name, needle, haystack == NULL ? "(null)" : haystack);
}

typedef struct {
  const char *city;
  int degree_celsius;
  double humidity;
} temperature_t;

int main(void) {
  const int numbers[4] = {10, 20, 30, 40};
  const char *json = exploring_collections_dump_int_array(numbers, 4);
  check_contains("int array envelope", json, "\"__ec\":1");
  check_contains("int array kind", json, "\"kind\":\"sequence\"");
  check_contains("int array total", json, "\"total\":4");
  check_contains("int array items", json, "[10,20,30,40]");

  const double values[3] = {1.5, 2.25, 3.0};
  json = exploring_collections_dump_double_array(values, 3);
  check_contains("double array", json, "[1.5,2.25,3]");

  const char *names[2] = {"Seoul", "Lima"};
  json = exploring_collections_dump_string_array(names, 2);
  check_contains("string array", json, "[\"Seoul\",\"Lima\"]");

  const temperature_t temperatures[2] = {{"Seoul", 21, 55.5}, {"Lima", 19, 70.25}};
  const ec_field_descriptor fields[3] = {
      {"city", offsetof(temperature_t, city), EC_FIELD_STRING},
      {"degree_celsius", offsetof(temperature_t, degree_celsius), EC_FIELD_INT},
      {"humidity", offsetof(temperature_t, humidity), EC_FIELD_DOUBLE},
  };

  json = exploring_collections_dump_structs(temperatures, 2, sizeof(temperature_t), fields, 3);
  check_contains("structs envelope", json, "\"kind\":\"sequence\"");
  check_contains("structs total", json, "\"total\":2");
  check_contains("struct field name", json, "\"city\"");
  check_contains("struct field value", json, "\"Seoul\"");
  check_contains("struct number", json, "\"degree_celsius\":21");
  check_contains("struct double", json, "\"humidity\":55.5");

  json = exploring_collections_dump_json(temperatures, 1, sizeof(temperature_t), fields, 3);
  check_contains("single record", json, "\"kind\":\"record\"");
  check_contains("single record value", json, "\"Seoul\"");

  /* The shared buffer is valid until the next call. */
  const char *again = exploring_collections_dump_int_array(numbers, 4);
  check("buffer reuse", again != NULL && strstr(again, "40") != NULL);

  printf("%s\n", failures == 0 ? "c helper: all checks passed" : "c helper: failures detected");
  return failures == 0 ? 0 : 1;
}
