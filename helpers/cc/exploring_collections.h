// Exploring Collections helper for C and C++ debuggees.
//
// The extension calls a helper compiled into your program, for example from the
// Debug Console while stopped at a breakpoint:
//
//     exploring_collections::dump_json_cstr(temperatures)
//
// The helper returns the JSON envelope the extension understands:
//
//     { "__ec": 1, "kind": "sequence" | "mapping" | "record", "total": 14, "items": [ ... ] }
//
// C++17 is required for the template API; the C API below compiles as C99.
// The returned string lives in an internal buffer that the next call overwrites,
// so nothing leaks and debugger expressions stay short.
//
// User defined types opt in with the EC_OBJECT macro:
//
//     struct Temperature { std::string city; int degree; };
//     EC_OBJECT(Temperature, city, degree)
//
// A struct without an EC_OBJECT specialization is still reported when it can be
// streamed with `operator<<`; it then becomes a single string cell.

#ifndef EXPLORING_COLLECTIONS_H
#define EXPLORING_COLLECTIONS_H

/** Version of this helper, aligned with the extension release. */
#define EXPLORING_COLLECTIONS_VERSION "1.0.0"

#ifdef __cplusplus
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
#else
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#endif

/* ================================================================ C API */

#ifdef __cplusplus
extern "C" {
#endif

/** Field kinds understood by the C API. */
typedef enum {
  EC_FIELD_INT = 0,
  EC_FIELD_LONG = 1,
  EC_FIELD_DOUBLE = 2,
  EC_FIELD_FLOAT = 3,
  EC_FIELD_BOOL = 4,
  EC_FIELD_STRING = 5
} ec_field_type;

/** Describes one member of a C struct. */
typedef struct {
  const char *name;
  /** Byte offset of the member inside the struct (`offsetof`). */
  size_t offset;
  ec_field_type type;
} ec_field_descriptor;

/** Serializes an int array. The returned buffer is valid until the next call. */
const char *exploring_collections_dump_int_array(const int *values, size_t count);

/** Serializes a double array. The returned buffer is valid until the next call. */
const char *exploring_collections_dump_double_array(const double *values, size_t count);

/** Serializes an array of C strings. The returned buffer is valid until the next call. */
const char *exploring_collections_dump_string_array(const char *const *values, size_t count);

/** Serializes an array of structs described by `fields`. */
const char *exploring_collections_dump_structs(const void *base,
                                               size_t count,
                                               size_t stride,
                                               const ec_field_descriptor *fields,
                                               size_t field_count);

/**
 * Generic entry point: for `count > 1` the values are treated as an array of
 * records described by `fields`, otherwise as a single record.
 */
const char *exploring_collections_dump_json(const void *base,
                                            size_t count,
                                            size_t stride,
                                            const ec_field_descriptor *fields,
                                            size_t field_count);

#ifdef __cplusplus
}
#endif

/* ================================================================ C++ API */

#ifdef __cplusplus

#if __cplusplus < 201703L
#error "The Exploring Collections C++ helper requires C++17 (compile with -std=c++17)."
#endif

#include <array>
#include <cmath>
#include <deque>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <ostream>
#include <set>
#include <sstream>
#include <tuple>
#include <typeinfo>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace exploring_collections {

struct Limits {
  int max_depth = 8;
  std::size_t max_items = 200000;
};

/* ------------------------------------------------------------- detection */

template <class T> struct is_std_string : std::false_type {};
template <class C, class Tr, class Al>
struct is_std_string<std::basic_string<C, Tr, Al>> : std::true_type {};

template <class T> struct is_pair : std::false_type {};
template <class A, class B> struct is_pair<std::pair<A, B>> : std::true_type {};

template <class T> struct is_mapping : std::false_type {};
template <class K, class V, class C, class A>
struct is_mapping<std::map<K, V, C, A>> : std::true_type {};
template <class K, class V, class H, class E, class A>
struct is_mapping<std::unordered_map<K, V, H, E, A>> : std::true_type {};

template <class T> struct is_sequence : std::false_type {};
template <class T, class A> struct is_sequence<std::vector<T, A>> : std::true_type {};
template <class T, class A> struct is_sequence<std::list<T, A>> : std::true_type {};
template <class T, class A> struct is_sequence<std::deque<T, A>> : std::true_type {};
template <class T, class C, class A> struct is_sequence<std::set<T, C, A>> : std::true_type {};
template <class T, class C, class A> struct is_sequence<std::multiset<T, C, A>> : std::true_type {};
template <class T, class H, class E, class A>
struct is_sequence<std::unordered_set<T, H, E, A>> : std::true_type {};
template <class T, std::size_t N> struct is_sequence<std::array<T, N>> : std::true_type {};

template <class T> struct is_optional : std::false_type {};
template <class T> struct is_optional<std::optional<T>> : std::true_type {};

template <class T> struct is_tuple : std::false_type {};
template <class... Ts> struct is_tuple<std::tuple<Ts...>> : std::true_type {};

template <class T> struct is_smart_pointer : std::false_type {};
template <class T> struct is_smart_pointer<std::shared_ptr<T>> : std::true_type {};
template <class T, class D> struct is_smart_pointer<std::unique_ptr<T, D>> : std::true_type {};

/** Streamable fallback detection. */
template <class T, class = void> struct has_stream_operator : std::false_type {};
template <class T>
struct has_stream_operator<T,
                           std::void_t<decltype(std::declval<std::ostream &>() << std::declval<const T &>())>>
    : std::true_type {};

/** Specializations opt a user defined type in (see the EC_OBJECT macro). */
template <class T> struct object_writer {
  static constexpr bool available = false;
};

/* ---------------------------------------------------------------- helpers */

inline void append_json_string(std::string &out, const std::string &value) {
  out.push_back('"');
  for (unsigned char character : value) {
    switch (character) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (character < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned>(character));
          out += buffer;
        } else {
          out.push_back(static_cast<char>(character));
        }
        break;
    }
  }
  out.push_back('"');
}

inline std::string json_string(const std::string &value) {
  std::string out;
  append_json_string(out, value);
  return out;
}

template <class T> inline std::string json_number(T value) {
  if (std::is_floating_point<T>::value) {
    const double number = static_cast<double>(value);
    if (std::isnan(number)) {
      return json_string("NaN");
    }
    if (std::isinf(number)) {
      return json_string(number > 0 ? "Infinity" : "-Infinity");
    }
    std::ostringstream stream;
    stream.precision(17);
    stream << number;
    return stream.str();
  }
  std::ostringstream stream;
  stream << value;
  return stream.str();
}

template <class T> inline std::size_t size_of(const T &value) { return value.size(); }
template <class T, std::size_t N> inline std::size_t size_of(const T (&)[N]) { return N; }

/** True for standard containers and for C arrays (where decay would lose the size). */
template <class T> constexpr bool is_sequence_like() {
  using Raw = typename std::remove_reference<T>::type;
  using U = typename std::decay<T>::type;
  return std::is_array<Raw>::value || is_sequence<U>::value;
}

/** True for C arrays specifically. */
template <class T> constexpr bool is_c_array() {
  using Raw = typename std::remove_reference<T>::type;
  return std::is_array<Raw>::value;
}

/** Builds a JSON object, used by EC_OBJECT and by custom serializers. */
class ObjectBuilder {
public:
  ObjectBuilder(int depth, const Limits &limits) : depth_(depth), limits_(limits) {}

  template <class T> ObjectBuilder &field(const char *name, const T &value);

  std::string str() const {
    std::string out = "{";
    out += body_;
    out += "}";
    return out;
  }

  std::string &raw() { return body_; }

private:
  std::string body_;
  bool first_ = true;
  int depth_;
  Limits limits_;
};

/* --------------------------------------------------------------- front end */

template <class T> std::string to_json(const T &value, int depth, const Limits &limits);

template <class T> ObjectBuilder &ObjectBuilder::field(const char *name, const T &value) {
  if (!first_) {
    body_ += ',';
  }
  first_ = false;
  append_json_string(body_, std::string(name));
  body_ += ':';
  body_ += to_json(value, depth_ + 1, limits_);
  return *this;
}

template <std::size_t Index, class Tuple>
inline void append_tuple_element(std::string &out,
                                 const Tuple &value,
                                 int depth,
                                 const Limits &limits) {
  if (Index > 0) {
    out += ',';
  }
  out += to_json(std::get<Index>(value), depth + 1, limits);
}

template <class Tuple, std::size_t... Indexes>
inline void write_tuple(std::string &out,
                        const Tuple &value,
                        int depth,
                        const Limits &limits,
                        std::index_sequence<Indexes...>) {
  (append_tuple_element<Indexes>(out, value, depth, limits), ...);
}

/** Renders any supported value as JSON. */
template <class T> inline std::string to_json(const T &value, int depth, const Limits &limits) {
  using U = typename std::decay<T>::type;

  if constexpr (std::is_same<U, bool>::value) {
    return value ? "true" : "false";
  } else if constexpr (std::is_same<U, char>::value) {
    return json_string(std::string(1, value));
  } else if constexpr (std::is_enum<U>::value) {
    // Without reflection the member name is unknown, so the numeric value is
    // reported; scoped enums do not support streaming.
    return json_number(static_cast<long long>(value));
  } else if constexpr (std::is_arithmetic<U>::value) {
    return json_number(value);
  } else if constexpr (is_std_string<U>::value) {
    return json_string(value);
  } else if constexpr (std::is_same<U, const char *>::value || std::is_same<U, char *>::value) {
    return json_string(value == nullptr ? std::string() : std::string(value));
  } else if constexpr (std::is_pointer<U>::value) {
    if (value == nullptr) {
      return "null";
    }
    return to_json(*value, depth + 1, limits);
  } else if constexpr (is_smart_pointer<U>::value) {
    if (!value) {
      return "null";
    }
    return to_json(*value, depth + 1, limits);
  } else if constexpr (is_optional<U>::value) {
    return value.has_value() ? to_json(*value, depth + 1, limits) : std::string("null");
  } else if constexpr (is_pair<U>::value) {
    std::string out = "[";
    out += to_json(value.first, depth + 1, limits);
    out += ',';
    out += to_json(value.second, depth + 1, limits);
    out += "]";
    return out;
  } else if constexpr (is_mapping<U>::value) {
    if (depth >= limits.max_depth) {
      return json_string("<max depth>");
    }
    std::string out = "{";
    std::size_t index = 0;
    for (const auto &entry : value) {
      if (index >= limits.max_items) {
        break;
      }
      if (index > 0) {
        out += ',';
      }
      std::ostringstream key;
      key << entry.first;
      out += json_string(key.str());
      out += ':';
      out += to_json(entry.second, depth + 1, limits);
      ++index;
    }
    out += "}";
    return out;
  } else if constexpr (is_sequence<U>::value) {
    if (depth >= limits.max_depth) {
      return json_string("<max depth>");
    }
    std::string out = "[";
    std::size_t index = 0;
    for (const auto &element : value) {
      if (index >= limits.max_items) {
        break;
      }
      if (index > 0) {
        out += ',';
      }
      out += to_json(element, depth + 1, limits);
      ++index;
    }
    out += "]";
    return out;
  } else if constexpr (is_tuple<U>::value) {
    if (depth >= limits.max_depth) {
      return json_string("<max depth>");
    }
    std::string out = "[";
    write_tuple(out, value, depth, limits, std::make_index_sequence<std::tuple_size<U>::value>{});
    out += "]";
    return out;
  } else if constexpr (object_writer<U>::available) {
    if (depth >= limits.max_depth) {
      return json_string("<max depth>");
    }
    return object_writer<U>::write(value, depth, limits);
  } else if constexpr (has_stream_operator<U>::value) {
    std::ostringstream stream;
    stream << value;
    return json_string(stream.str());
  } else {
    return json_string(std::string("<") + typeid(U).name() + ">");
  }
}

/** C array of known size, kept separate so the size is not lost to decay. */
template <class T, std::size_t N>
inline std::string to_json(const T (&value)[N], int depth, const Limits &limits) {
  if (depth >= limits.max_depth) {
    return json_string("<max depth>");
  }
  std::string out = "[";
  for (std::size_t index = 0; index < N && index < limits.max_items; ++index) {
    if (index > 0) {
      out += ',';
    }
    out += to_json(value[index], depth + 1, limits);
  }
  out += "]";
  return out;
}

/* ------------------------------------------------------------- envelope */

template <class T> constexpr const char *kind_of() {
  using U = typename std::decay<T>::type;
  if constexpr (is_mapping<U>::value) {
    return "mapping";
  } else if constexpr (is_sequence_like<T>()) {
    return "sequence";
  } else {
    return "record";
  }
}

template <class T> inline std::string total_of(const T &value) {
  using U = typename std::decay<T>::type;
  if constexpr (is_mapping<U>::value || is_sequence_like<T>()) {
    return std::to_string(size_of(value));
  } else {
    return "1";
  }
}

template <class T> inline std::string dump_json_with_limits(const T &value, const Limits &limits) {
  using U = typename std::decay<T>::type;
  std::string out = "{\"__ec\":1,\"kind\":";
  out += json_string(kind_of<T>());
  out += ",\"total\":";
  out += total_of(value);
  out += ",\"items\":[";

  if constexpr (is_mapping<U>::value) {
    std::size_t index = 0;
    for (const auto &entry : value) {
      if (index >= limits.max_items) {
        break;
      }
      if (index > 0) {
        out += ',';
      }
      std::string key;
      if constexpr (is_std_string<typename std::decay<decltype(entry.first)>::type>::value) {
        key = json_string(entry.first);
      } else {
        std::ostringstream stream;
        stream << entry.first;
        key = json_string(stream.str());
      }
      out += '[';
      out += key;
      out += ',';
      out += to_json(entry.second, 2, limits);
      out += ']';
      ++index;
    }
  } else if constexpr (is_sequence_like<T>()) {
    std::size_t index = 0;
    for (const auto &element : value) {
      if (index >= limits.max_items) {
        break;
      }
      if (index > 0) {
        out += ',';
      }
      out += to_json(element, 1, limits);
      ++index;
    }
  } else {
    out += to_json(value, 0, limits);
  }

  out += "]}";
  return out;
}

/** Serializes any supported value into the envelope JSON. */
template <class T> inline std::string dump_json(const T &value) {
  return dump_json_with_limits(value, Limits());
}

/**
 * Serializes into an internal buffer and returns a C string, which is what the
 * debugger prints as a quoted string.
 */
template <class T> inline const char *dump_json_cstr(const T &value) {
  static std::string buffer;
  buffer = dump_json(value);
  return buffer.c_str();
}

/** Returns a short, human readable description of a value. */
template <class T> inline std::string describe(const T &value) {
  std::ostringstream stream;
  stream << value;
  std::string text = stream.str();
  if (text.size() > 120) {
    text.resize(119);
    text += "...";
  }
  return text;
}

}  // namespace exploring_collections

/* ---------------------------------------------------------------- macros */

#define EC_FIELD(value, builder, name) (builder).field(#name, (value).name);

#define EC_APPLY_1(v, b, a1) EC_FIELD(v, b, a1)
#define EC_APPLY_2(v, b, a1, a2) EC_FIELD(v, b, a1) EC_APPLY_1(v, b, a2)
#define EC_APPLY_3(v, b, a1, a2, a3) EC_FIELD(v, b, a1) EC_APPLY_2(v, b, a2, a3)
#define EC_APPLY_4(v, b, a1, a2, a3, a4) EC_FIELD(v, b, a1) EC_APPLY_3(v, b, a2, a3, a4)
#define EC_APPLY_5(v, b, a1, a2, a3, a4, a5) EC_FIELD(v, b, a1) EC_APPLY_4(v, b, a2, a3, a4, a5)
#define EC_APPLY_6(v, b, a1, a2, a3, a4, a5, a6) EC_FIELD(v, b, a1) EC_APPLY_5(v, b, a2, a3, a4, a5, a6)
#define EC_APPLY_7(v, b, a1, a2, a3, a4, a5, a6, a7) EC_FIELD(v, b, a1) EC_APPLY_6(v, b, a2, a3, a4, a5, a6, a7)
#define EC_APPLY_8(v, b, a1, a2, a3, a4, a5, a6, a7, a8) EC_FIELD(v, b, a1) EC_APPLY_7(v, b, a2, a3, a4, a5, a6, a7, a8)
#define EC_APPLY_9(v, b, a1, a2, a3, a4, a5, a6, a7, a8, a9) EC_FIELD(v, b, a1) EC_APPLY_8(v, b, a2, a3, a4, a5, a6, a7, a8, a9)
#define EC_APPLY_10(v, b, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) EC_FIELD(v, b, a1) EC_APPLY_9(v, b, a2, a3, a4, a5, a6, a7, a8, a9, a10)
#define EC_APPLY_11(v, b, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) EC_FIELD(v, b, a1) EC_APPLY_10(v, b, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11)
#define EC_APPLY_12(v, b, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) EC_FIELD(v, b, a1) EC_APPLY_11(v, b, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12)

#define EC_SELECT_APPLY(_1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, NAME, ...) NAME
#define EC_APPLY_FIELDS(value, builder, ...)                                                    \
  EC_SELECT_APPLY(__VA_ARGS__, EC_APPLY_12, EC_APPLY_11, EC_APPLY_10, EC_APPLY_9, EC_APPLY_8,   \
                  EC_APPLY_7, EC_APPLY_6, EC_APPLY_5, EC_APPLY_4, EC_APPLY_3, EC_APPLY_2,       \
                  EC_APPLY_1)(value, builder, __VA_ARGS__)

/**
 * Opts a user defined type in, so its members become columns:
 *
 *     EC_OBJECT(Temperature, city, degreeCelsius)
 */
#define EC_OBJECT(Type, ...)                                                       \
  namespace exploring_collections {                                                \
  template <> struct object_writer<Type> {                                         \
    static constexpr bool available = true;                                        \
    static std::string write(const Type &value, int depth, const Limits &limits) {  \
      ObjectBuilder builder(depth, limits);                                         \
      EC_APPLY_FIELDS(value, builder, __VA_ARGS__)                                  \
      return builder.str();                                                         \
    }                                                                              \
  };                                                                               \
  }

#endif /* __cplusplus */
#endif /* EXPLORING_COLLECTIONS_H */
