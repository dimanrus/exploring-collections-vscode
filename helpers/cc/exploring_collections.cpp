// Implementation of the C API declared in exploring_collections.h.
//
// Compile this file together with your project (or the C++ header only).
// C++17 is required.

#include "exploring_collections.h"

#include <cmath>
#include <cstdint>
#include <sstream>
#include <string>

namespace {

std::string &shared_buffer() {
  // A single buffer that the next call overwrites: debugger expressions stay
  // short and nothing has to be freed inside the debuggee.
  static std::string buffer;
  return buffer;
}

void append_escaped(std::string &out, const char *text) {
  out.push_back('"');
  if (text != nullptr) {
    for (const unsigned char *cursor = reinterpret_cast<const unsigned char *>(text); *cursor != 0;
         ++cursor) {
      const unsigned char character = *cursor;
      switch (character) {
        case '"':
          out += "\\\"";
          break;
        case '\\':
          out += "\\\\";
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
  }
  out.push_back('"');
}

std::string envelope(const char *kind, std::int64_t total, const std::string &items) {
  std::string out = "{\"__ec\":1,\"kind\":";
  append_escaped(out, kind);
  out += ",\"total\":";
  out += std::to_string(total);
  out += ",\"items\":[";
  out += items;
  out += "]}";
  return out;
}

void append_double(std::string &out, double value) {
  if (std::isnan(value)) {
    append_escaped(out, "NaN");
  } else if (std::isinf(value)) {
    append_escaped(out, value > 0 ? "Infinity" : "-Infinity");
  } else {
    std::ostringstream stream;
    stream.precision(17);
    stream << value;
    out += stream.str();
  }
}

void append_field_value(std::string &out, const unsigned char *row, const ec_field_descriptor &field) {
  const unsigned char *address = row + field.offset;
  switch (field.type) {
    case EC_FIELD_INT: {
      int value = 0;
      std::memcpy(&value, address, sizeof(int));
      out += std::to_string(value);
      break;
    }
    case EC_FIELD_LONG: {
      long value = 0;
      std::memcpy(&value, address, sizeof(long));
      out += std::to_string(value);
      break;
    }
    case EC_FIELD_DOUBLE: {
      double value = 0;
      std::memcpy(&value, address, sizeof(double));
      append_double(out, value);
      break;
    }
    case EC_FIELD_FLOAT: {
      float value = 0;
      std::memcpy(&value, address, sizeof(float));
      append_double(out, static_cast<double>(value));
      break;
    }
    case EC_FIELD_BOOL: {
      int value = 0;
      std::memcpy(&value, address, sizeof(int));
      out += value != 0 ? "true" : "false";
      break;
    }
    case EC_FIELD_STRING: {
      char *value = nullptr;
      std::memcpy(&value, address, sizeof(char *));
      append_escaped(out, value);
      break;
    }
    default:
      out += "null";
      break;
  }
}

std::string struct_row(const unsigned char *row,
                       const ec_field_descriptor *fields,
                       size_t field_count) {
  std::string out = "{";
  for (size_t index = 0; index < field_count; ++index) {
    if (index > 0) {
      out += ',';
    }
    append_escaped(out, fields[index].name);
    out += ':';
    append_field_value(out, row, fields[index]);
  }
  out += '}';
  return out;
}

}  // namespace

extern "C" const char *exploring_collections_dump_int_array(const int *values, size_t count) {
  std::string items;
  if (values != nullptr) {
    for (size_t index = 0; index < count; ++index) {
      if (index > 0) {
        items += ',';
      }
      items += std::to_string(values[index]);
    }
  }
  shared_buffer() = envelope("sequence", static_cast<std::int64_t>(count), items);
  return shared_buffer().c_str();
}

extern "C" const char *exploring_collections_dump_double_array(const double *values, size_t count) {
  std::string items;
  if (values != nullptr) {
    for (size_t index = 0; index < count; ++index) {
      if (index > 0) {
        items += ',';
      }
      append_double(items, values[index]);
    }
  }
  shared_buffer() = envelope("sequence", static_cast<std::int64_t>(count), items);
  return shared_buffer().c_str();
}

extern "C" const char *exploring_collections_dump_string_array(const char *const *values, size_t count) {
  std::string items;
  if (values != nullptr) {
    for (size_t index = 0; index < count; ++index) {
      if (index > 0) {
        items += ',';
      }
      append_escaped(items, values[index]);
    }
  }
  shared_buffer() = envelope("sequence", static_cast<std::int64_t>(count), items);
  return shared_buffer().c_str();
}

extern "C" const char *exploring_collections_dump_structs(const void *base,
                                                          size_t count,
                                                          size_t stride,
                                                          const ec_field_descriptor *fields,
                                                          size_t field_count) {
  std::string items;
  if (base != nullptr && fields != nullptr) {
    const unsigned char *cursor = static_cast<const unsigned char *>(base);
    for (size_t index = 0; index < count; ++index) {
      if (index > 0) {
        items += ',';
      }
      items += struct_row(cursor + index * stride, fields, field_count);
    }
  }
  shared_buffer() = envelope("sequence", static_cast<std::int64_t>(count), items);
  return shared_buffer().c_str();
}

extern "C" const char *exploring_collections_dump_json(const void *base,
                                                       size_t count,
                                                       size_t stride,
                                                       const ec_field_descriptor *fields,
                                                       size_t field_count) {
  if (count > 1) {
    return exploring_collections_dump_structs(base, count, stride, fields, field_count);
  }
  if (base == nullptr || fields == nullptr) {
    shared_buffer() = envelope("record", 1, "{}");
    return shared_buffer().c_str();
  }
  const std::string row = struct_row(static_cast<const unsigned char *>(base), fields, field_count);
  shared_buffer() = envelope("record", 1, row);
  return shared_buffer().c_str();
}
