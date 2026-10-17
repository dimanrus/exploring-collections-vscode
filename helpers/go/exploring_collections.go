// Package exploringcollections serializes Go values into the collection envelope
// used by the Exploring Collections extension for Visual Studio Code.
//
// Add this file (or this package) to your module and call Dump from the Debug
// Console:
//
//	exploringcollections.Dump(temperatures)
//
// The returned string follows the envelope contract:
//
//	{ "__ec": 1, "kind": "sequence" | "mapping" | "record", "total": 14, "items": [ ... ] }
//
// Delve only evaluates such calls when it is started with call support
// (dlv dap --allow-non-terminal-interactive=true, or the "call" support flag of
// your client). Without it the extension falls back to the variables tree.
package exploringcollections

import (
	"encoding"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Version is the helper version, aligned with the extension release.
const Version = "1.0.0"

const (
	// DefaultMaxDepth limits how deep nested containers are expanded.
	DefaultMaxDepth = 8
	// DefaultMaxItems limits how many elements of a container are emitted.
	DefaultMaxItems = 200000
)

var (
	timeType = reflect.TypeOf(time.Time{})
)

// Dump serializes value with the default limits.
func Dump(value any) string {
	return DumpWithLimits(value, DefaultMaxDepth, DefaultMaxItems)
}

// DumpWithLimits serializes value into the envelope JSON string.
func DumpWithLimits(value any, maxDepth, maxItems int) string {
	if maxDepth <= 0 {
		maxDepth = DefaultMaxDepth
	}
	if maxItems <= 0 {
		maxItems = DefaultMaxItems
	}

	encoder := &encoder{
		maxDepth: maxDepth,
		maxItems: maxItems,
		visited:  make(map[visit]bool),
	}
	encoder.writeEnvelope(reflect.ValueOf(value))
	return encoder.builder.String()
}

// Describe returns a short, human readable description of a value.
func Describe(value any) string {
	if value == nil {
		return "null"
	}
	reflected := reflect.ValueOf(value)
	for reflected.Kind() == reflect.Interface && !reflected.IsNil() {
		reflected = reflected.Elem()
	}
	switch reflected.Kind() {
	case reflect.Slice, reflect.Array:
		return fmt.Sprintf("%s[%d]", reflected.Type(), reflected.Len())
	case reflect.Map:
		return fmt.Sprintf("%s[%d]", reflected.Type(), reflected.Len())
	case reflect.String:
		text := reflected.String()
		if len(text) > 120 {
			return text[:119] + "..."
		}
		return text
	default:
		return reflected.Type().String()
	}
}

type visit struct {
	pointer uintptr
	typeID  reflect.Type
	length  int
}

type encoder struct {
	builder  strings.Builder
	maxDepth int
	maxItems int
	visited  map[visit]bool
}

func (e *encoder) writeEnvelope(value reflect.Value) {
	kind, total, items := e.classify(value)
	e.builder.WriteString(`{"__ec":1,"kind":`)
	e.writeRawString(kind)
	e.builder.WriteString(`,"total":`)
	if total < 0 {
		e.builder.WriteString("null")
	} else {
		e.builder.WriteString(strconv.Itoa(total))
	}
	e.builder.WriteString(`,"items":[`)

	switch kind {
	case "mapping":
		writeComma := false
		written := 0
		for _, key := range items.MapKeys() {
			if written >= e.maxItems {
				break
			}
			written++
			if writeComma {
				e.builder.WriteByte(',')
			}
			writeComma = true
			e.builder.WriteByte('[')
			e.writeValue(key, 1)
			e.builder.WriteByte(',')
			e.writeValue(items.MapIndex(key), e.maxDepth-2)
			e.builder.WriteByte(']')
		}
	case "sequence":
		written := 0
		for index := 0; index < items.Len() && written < e.maxItems; index++ {
			if index > 0 {
				e.builder.WriteByte(',')
			}
			written++
			e.writeValue(items.Index(index), e.maxDepth-1)
		}
	default:
		e.writeValue(value, e.maxDepth-1)
	}

	e.builder.WriteString("]}")
}

// classify unwraps the value and reports the envelope kind plus the total.
func (e *encoder) classify(value reflect.Value) (string, int, reflect.Value) {
	total := -1
	if !value.IsValid() {
		return "record", total, value
	}

	unwrapped := unwrap(value)
	if !unwrapped.IsValid() {
		return "record", total, unwrapped
	}

	switch unwrapped.Kind() {
	case reflect.Slice, reflect.Array:
		if unwrapped.Kind() == reflect.Slice && unwrapped.IsNil() {
			return "sequence", 0, unwrapped
		}
		return "sequence", unwrapped.Len(), unwrapped
	case reflect.Map:
		if unwrapped.IsNil() {
			return "mapping", 0, unwrapped
		}
		return "mapping", unwrapped.Len(), unwrapped
	default:
		return "record", 1, unwrapped
	}
}

// unwrap removes interfaces and - unless the pointer itself is the value of
// interest - pointers, so that `*T` behaves like `T` and nil becomes null.
func unwrap(value reflect.Value) reflect.Value {
	for value.IsValid() {
		switch value.Kind() {
		case reflect.Interface:
			if value.IsNil() {
				return value
			}
			value = value.Elem()
		case reflect.Pointer:
			if value.IsNil() {
				return value
			}
			value = value.Elem()
		default:
			return value
		}
	}
	return value
}

func (e *encoder) writeValue(value reflect.Value, depth int) {
	if !value.IsValid() {
		e.builder.WriteString("null")
		return
	}

	// Interfaces are unwrapped first so that the concrete value can be tracked
	// for cycles: reflect.Value.Pointer only works on concrete reference kinds.
	concrete := concreteValue(value)
	if !concrete.IsValid() {
		e.builder.WriteString("null")
		return
	}

	// Honour json.Marshaler and encoding.TextMarshaler implementations.
	if concrete.CanInterface() && !(concrete.Kind() == reflect.Pointer && concrete.IsNil()) {
		interfaceValue := concrete.Interface()
		if marshaler, ok := interfaceValue.(json.Marshaler); ok {
			if encoded, marshalled := tryMarshalJSON(marshaler); marshalled {
				e.builder.Write(encoded)
				return
			}
		}
		if textMarshaler, ok := interfaceValue.(encoding.TextMarshaler); ok {
			if text, marshalled := tryMarshalText(textMarshaler); marshalled {
				e.writeString(text)
				return
			}
		}
	}

	// Cycle detection happens before pointers are dereferenced: a pointer that
	// points at itself must be caught, and dereferencing would hide it.
	reference, tracked, proceed := e.trackReference(concrete)
	if !proceed {
		return
	}
	if tracked {
		defer e.leave(reference)
	}

	unwrapped := unwrap(concrete)
	if !unwrapped.IsValid() {
		e.builder.WriteString("null")
		return
	}

	if unwrapped.Type() == timeType {
		instant, ok := unwrapped.Interface().(time.Time)
		if !ok {
			e.writeString(wrappedDescribe(unwrapped))
			return
		}
		e.writeString(instant.Format(time.RFC3339Nano))
		return
	}

	switch unwrapped.Kind() {
	case reflect.Bool:
		if unwrapped.Bool() {
			e.builder.WriteString("true")
		} else {
			e.builder.WriteString("false")
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		e.builder.WriteString(strconv.FormatInt(unwrapped.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		e.builder.WriteString(strconv.FormatUint(unwrapped.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		e.writeFloat(unwrapped.Float())
	case reflect.Complex64, reflect.Complex128:
		e.writeString(fmt.Sprint(unwrapped.Complex()))
	case reflect.String:
		e.writeString(unwrapped.String())
	case reflect.Func, reflect.Chan, reflect.UnsafePointer:
		e.writeString("<" + unwrapped.Type().String() + ">")
	case reflect.Pointer, reflect.Interface:
		// Only reachable for nil pointers and nil interfaces.
		e.builder.WriteString("null")
	default:
		e.writeContainer(unwrapped, depth)
	}
}

func tryMarshalJSON(marshaler json.Marshaler) (encoded []byte, ok bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			encoded, ok = nil, false
		}
	}()

	payload, err := marshaler.MarshalJSON()
	if err != nil {
		return nil, false
	}
	return payload, true
}

func tryMarshalText(marshaler encoding.TextMarshaler) (text string, ok bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			text, ok = "", false
		}
	}()

	payload, err := marshaler.MarshalText()
	if err != nil {
		return "", false
	}
	return string(payload), true
}

func wrappedDescribe(value reflect.Value) string {
	if value.CanInterface() {
		return fmt.Sprint(value.Interface())
	}
	return "<" + value.Type().String() + ">"
}

// concreteValue removes interface wrappers, leaving the dynamic value.
func concreteValue(value reflect.Value) reflect.Value {
	for value.IsValid() && value.Kind() == reflect.Interface {
		if value.IsNil() {
			return value
		}
		value = value.Elem()
	}
	return value
}

func (e *encoder) writeContainer(value reflect.Value, depth int) {
	if depth <= 0 {
		e.writeString(e.placeholder(value))
		return
	}

	switch value.Kind() {
	case reflect.Slice, reflect.Array:
		e.writeArray(value, depth)
	case reflect.Map:
		e.writeMap(value, depth)
	case reflect.Struct:
		e.writeStruct(value, depth)
	default:
		e.writeString(fmt.Sprintf("<%s>", value.Type().String()))
	}
}

func (e *encoder) writeArray(value reflect.Value, depth int) {
	e.builder.WriteByte('[')
	limit := value.Len()
	if limit > e.maxItems {
		limit = e.maxItems
	}
	for index := 0; index < limit; index++ {
		if index > 0 {
			e.builder.WriteByte(',')
		}
		e.writeValue(value.Index(index), depth-1)
	}
	e.builder.WriteByte(']')
}

func (e *encoder) writeMap(value reflect.Value, depth int) {
	e.builder.WriteByte('{')
	written := 0
	for _, key := range value.MapKeys() {
		if written >= e.maxItems {
			break
		}
		if written > 0 {
			e.builder.WriteByte(',')
		}
		written++
		e.writeString(fmt.Sprint(key.Interface()))
		e.builder.WriteByte(':')
		e.writeValue(value.MapIndex(key), depth-1)
	}
	e.builder.WriteByte('}')
}

func (e *encoder) writeStruct(value reflect.Value, depth int) {
	valueType := value.Type()
	e.builder.WriteByte('{')
	written := 0
	for index := 0; index < value.NumField(); index++ {
		field := valueType.Field(index)
		if field.PkgPath != "" {
			continue // unexported
		}

		name := field.Name
		if tag, ok := field.Tag.Lookup("json"); ok {
			parts := strings.Split(tag, ",")
			if parts[0] == "-" {
				continue
			}
			if parts[0] != "" {
				name = parts[0]
			}
		}

		if written > 0 {
			e.builder.WriteByte(',')
		}
		written++
		e.writeString(name)
		e.builder.WriteByte(':')
		e.writeValue(value.Field(index), depth-1)
	}
	e.builder.WriteByte('}')
}

func (e *encoder) placeholder(value reflect.Value) string {
	switch value.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return fmt.Sprintf("<%s len=%d>", value.Type().String(), value.Len())
	default:
		return fmt.Sprintf("<%s>", value.Type().String())
	}
}

// trackReference registers a pointer, map or slice for cycle detection.
//
// It returns the registration key, whether the caller has to release it, and
// whether writing should continue: when the reference was already visited on
// this path, "<circular>" has been written and the caller must stop.
func (e *encoder) trackReference(value reflect.Value) (visit, bool, bool) {
	switch value.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice:
	default:
		return visit{}, false, true
	}

	if value.IsNil() {
		return visit{}, false, true
	}

	reference := visit{pointer: value.Pointer(), typeID: value.Type()}
	if value.Kind() == reflect.Slice {
		// Slices that share a backing array must not be mistaken for a cycle.
		reference.length = value.Cap()
	}

	if e.visited[reference] {
		e.writeString("<circular>")
		return reference, false, false
	}

	e.visited[reference] = true
	return reference, true, true
}

func (e *encoder) leave(key visit) {
	delete(e.visited, key)
}

func (e *encoder) writeFloat(number float64) {
	if math.IsNaN(number) {
		e.writeString("NaN")
		return
	}
	if math.IsInf(number, 1) {
		e.writeString("Infinity")
		return
	}
	if math.IsInf(number, -1) {
		e.writeString("-Infinity")
		return
	}
	e.builder.WriteString(strconv.FormatFloat(number, 'g', -1, 64))
}

func (e *encoder) writeString(value string) {
	e.builder.WriteString(escapeJSONString(value))
}

func (e *encoder) writeRawString(value string) {
	e.writeString(value)
}

func escapeJSONString(value string) string {
	var builder strings.Builder
	builder.Grow(len(value) + 2)
	builder.WriteByte('"')
	for index := 0; index < len(value); {
		character := value[index]
		switch character {
		case '"':
			builder.WriteString(`\"`)
			index++
			continue
		case '\\':
			builder.WriteString(`\\`)
			index++
			continue
		case '\b':
			builder.WriteString(`\b`)
			index++
			continue
		case '\f':
			builder.WriteString(`\f`)
			index++
			continue
		case '\n':
			builder.WriteString(`\n`)
			index++
			continue
		case '\r':
			builder.WriteString(`\r`)
			index++
			continue
		case '\t':
			builder.WriteString(`\t`)
			index++
			continue
		}

		if character < 0x20 {
			builder.WriteString(`\u00`)
			builder.WriteByte(hexDigits[character>>4])
			builder.WriteByte(hexDigits[character&0x0f])
			index++
			continue
		}

		runeValue, size := utf8.DecodeRuneInString(value[index:])
		if runeValue == utf8.RuneError && size == 1 {
			// Invalid UTF-8: emit the replacement character so the payload stays valid JSON.
			builder.WriteRune(utf8.RuneError)
			index++
			continue
		}
		if runeValue == '\u2028' || runeValue == '\u2029' {
			builder.WriteString(`\u202`)
			builder.WriteByte(hexDigits[int(runeValue)&0x0f])
			index += size
			continue
		}
		builder.WriteString(value[index : index+size])
		index += size
	}
	builder.WriteByte('"')
	return builder.String()
}

const hexDigits = "0123456789abcdef"
