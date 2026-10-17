package exploringcollections

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

type Temperature struct {
	City          string    `json:"city"`
	DegreeCelsius int       `json:"degreeCelsius"`
	Date          time.Time `json:"date"`
	Feels         string    `json:"-"`
	internal      int
}

type Nested struct {
	Name    string
	Address *Address
}

type Address struct {
	City string
	Zip  string
}

type Node struct {
	Name string
	Self *Node
}

type Level struct {
	Name string
	Next *Level
}

func envelope(t *testing.T, payload string) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatalf("payload is not valid JSON: %v\n%s", err, payload)
	}
	if parsed["__ec"] != float64(1) {
		t.Fatalf("missing envelope marker: %s", payload)
	}
	return parsed
}

func items(t *testing.T, payload string) []any {
	t.Helper()
	parsed := envelope(t, payload)
	list, ok := parsed["items"].([]any)
	if !ok {
		t.Fatalf("items is not an array: %s", payload)
	}
	return list
}

func TestSliceOfStructs(t *testing.T) {
	values := []Temperature{
		{City: "Seoul", DegreeCelsius: 21, Date: time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC), Feels: "warm", internal: 1},
		{City: "Lima", DegreeCelsius: 19, Date: time.Date(2024, 4, 2, 0, 0, 0, 0, time.UTC)},
	}

	parsed := envelope(t, Dump(values))
	if parsed["kind"] != "sequence" {
		t.Fatalf("kind = %v, want sequence", parsed["kind"])
	}
	if parsed["total"] != float64(2) {
		t.Fatalf("total = %v, want 2", parsed["total"])
	}

	first := items(t, Dump(values))[0].(map[string]any)
	if first["city"] != "Seoul" {
		t.Fatalf("json tag not honoured: %v", first)
	}
	if _, present := first["Feels"]; present {
		t.Fatalf("json:\"-\" field was serialized: %v", first)
	}
	if _, present := first["internal"]; present {
		t.Fatalf("unexported field was serialized: %v", first)
	}
	if !strings.HasPrefix(first["date"].(string), "2024-04-01") {
		t.Fatalf("time.Time not ISO formatted: %v", first["date"])
	}
}

func TestMapping(t *testing.T) {
	parsed := envelope(t, Dump(map[string]int{"Seoul": 21, "Lima": 19}))
	if parsed["kind"] != "mapping" {
		t.Fatalf("kind = %v, want mapping", parsed["kind"])
	}
	if parsed["total"] != float64(2) {
		t.Fatalf("total = %v, want 2", parsed["total"])
	}
	pair := items(t, Dump(map[string]int{"Seoul": 21}))[0].([]any)
	if pair[0] != "Seoul" || pair[1] != float64(21) {
		t.Fatalf("pair = %v", pair)
	}
}

func TestRecordMode(t *testing.T) {
	parsed := envelope(t, Dump(Nested{Name: "root", Address: &Address{City: "Seoul", Zip: "04524"}}))
	if parsed["kind"] != "record" {
		t.Fatalf("kind = %v, want record", parsed["kind"])
	}
	record := items(t, Dump(Nested{Name: "root", Address: &Address{City: "Seoul"}}))[0].(map[string]any)
	if record["Name"] != "root" {
		t.Fatalf("record field missing: %v", record)
	}
	address := record["Address"].(map[string]any)
	if address["City"] != "Seoul" {
		t.Fatalf("nested pointer not dereferenced: %v", address)
	}
}

func TestPrimitives(t *testing.T) {
	parsed := envelope(t, Dump("hello"))
	if parsed["kind"] != "record" {
		t.Fatalf("string kind = %v", parsed["kind"])
	}
	if items(t, Dump("hello"))[0] != "hello" {
		t.Fatalf("string item = %v", items(t, Dump("hello"))[0])
	}

	mixed := items(t, Dump([]any{1, 2.5, true, nil, "text"}))
	if mixed[0] != float64(1) || mixed[2] != true || mixed[3] != nil || mixed[4] != "text" {
		t.Fatalf("primitives = %v", mixed)
	}

	specials := items(t, Dump([]float64{math.NaN(), math.Inf(1), math.Inf(-1)}))
	if specials[0] != "NaN" || specials[1] != "Infinity" || specials[2] != "-Infinity" {
		t.Fatalf("special floats = %v", specials)
	}
}

func TestNilContainers(t *testing.T) {
	var slice []int
	parsed := envelope(t, Dump(slice))
	if parsed["kind"] != "sequence" || parsed["total"] != float64(0) {
		t.Fatalf("nil slice envelope = %v", parsed)
	}

	var mapping map[string]int
	parsed = envelope(t, Dump(mapping))
	if parsed["kind"] != "mapping" || parsed["total"] != float64(0) {
		t.Fatalf("nil map envelope = %v", parsed)
	}

	var pointer *Address
	if items(t, Dump(pointer))[0] != nil {
		t.Fatalf("nil pointer = %v", items(t, Dump(pointer))[0])
	}
}

func TestCycleGuard(t *testing.T) {
	root := &Node{Name: "root"}
	root.Self = root

	record := items(t, Dump(root))[0].(map[string]any)
	if record["Self"] != "<circular>" {
		t.Fatalf("cycle guard = %v", record["Self"])
	}

	// The same pointer appearing twice is not a cycle.
	shared := &Address{City: "Seoul"}
	both := items(t, Dump([]*Address{shared, shared}))
	if both[0].(map[string]any)["City"] != "Seoul" || both[1].(map[string]any)["City"] != "Seoul" {
		t.Fatalf("sibling duplicates = %v", both)
	}
}

func TestDepthLimit(t *testing.T) {
	root := &Level{Name: "1"}
	current := root
	for index := 2; index <= 12; index++ {
		current.Next = &Level{Name: "2"}
		current = current.Next
	}

	payload := Dump(root)
	if len(payload) > 4000 {
		t.Fatalf("depth limit did not bound the payload: %d bytes", len(payload))
	}
	if !strings.Contains(payload, "count=") && !strings.Contains(payload, "<") {
		t.Fatalf("expected a depth placeholder: %s", payload)
	}
}

func TestLimits(t *testing.T) {
	values := make([]int, 500)
	for index := range values {
		values[index] = index
	}

	parsed := envelope(t, DumpWithLimits(values, 4, 10))
	if parsed["total"] != float64(500) {
		t.Fatalf("total = %v, want 500", parsed["total"])
	}
	if len(parsed["items"].([]any)) != 10 {
		t.Fatalf("maxItems not honoured: %d", len(parsed["items"].([]any)))
	}

	parsed = envelope(t, DumpWithLimits(values, 0, 0))
	if parsed["total"] != float64(500) {
		t.Fatalf("defaults not applied: %v", parsed["total"])
	}
}

func TestEscaping(t *testing.T) {
	payload := Dump([]string{"quote\"backslash\\newline\n\ttab\u2028end", "üñïçødé", "<html>&"})
	if !json.Valid([]byte(payload)) {
		t.Fatalf("escaping produced invalid JSON: %s", payload)
	}
	parsed := items(t, payload)
	if parsed[0] != "quote\"backslash\\newline\n\ttab\u2028end" {
		t.Fatalf("round trip failed: %q", parsed[0])
	}
	if parsed[1] != "üñïçødé" {
		t.Fatalf("unicode round trip failed: %q", parsed[1])
	}
	if parsed[2] != "<html>&" {
		t.Fatalf("html must not be escaped: %q", parsed[2])
	}
}

func TestNestedMapsAndSlices(t *testing.T) {
	value := map[string][]int{"a": {1, 2, 3}, "b": {}}
	parsed := envelope(t, Dump(value))
	if parsed["kind"] != "mapping" {
		t.Fatalf("kind = %v", parsed["kind"])
	}
	for _, entry := range parsed["items"].([]any) {
		pair := entry.([]any)
		if pair[0] == "a" {
			list := pair[1].([]any)
			if len(list) != 3 || list[2] != float64(3) {
				t.Fatalf("nested slice = %v", list)
			}
		}
	}
}

func TestDescribe(t *testing.T) {
	if Describe(nil) != "null" {
		t.Fatalf("nil describe = %s", Describe(nil))
	}
	if Describe([]int{1, 2, 3}) != "[]int[3]" {
		t.Fatalf("slice describe = %s", Describe([]int{1, 2, 3}))
	}
	if !strings.HasPrefix(Describe("abcdef"), "abcdef") {
		t.Fatalf("string describe = %s", Describe("abcdef"))
	}
}

func TestArrayAndMapOfStructs(t *testing.T) {
	array := [2]Temperature{{City: "A"}, {City: "B"}}
	if envelope(t, Dump(array))["kind"] != "sequence" {
		t.Fatalf("array should be a sequence")
	}

	lookup := map[string]Temperature{"a": {City: "Seoul"}, "b": {City: "Lima"}}
	for _, entry := range envelope(t, Dump(lookup))["items"].([]any) {
		pair := entry.([]any)
		record := pair[1].(map[string]any)
		if record["city"] == nil {
			t.Fatalf("map value not serialized: %v", record)
		}
	}
}

func TestByteSlice(t *testing.T) {
	items := items(t, Dump([]byte{1, 2, 3}))
	if len(items) != 3 || items[0] != float64(1) {
		t.Fatalf("byte slice = %v", items)
	}
}

func TestNestedMapsAndCycles(t *testing.T) {
	// Nested maps exercise cycle tracking for reflect.Map values.
	inner := map[string]int{"a": 1}
	outer := map[string]map[string]int{"x": inner, "y": inner}
	parsed := envelope(t, Dump(outer))
	if parsed["kind"] != "mapping" || parsed["total"] != float64(2) {
		t.Fatalf("nested map envelope = %v", parsed)
	}
	for _, entry := range parsed["items"].([]any) {
		pair := entry.([]any)
		value := pair[1].(map[string]any)
		if value["a"] != float64(1) {
			t.Fatalf("nested map value = %v", value)
		}
	}

	// A map that contains itself must not recurse forever. A mapping envelope
	// reports entries as [key, value] pairs.
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	pair := items(t, Dump(cyclic))[0].([]any)
	selfRecord := pair[1].(map[string]any)
	if selfRecord["self"] != "<circular>" {
		t.Fatalf("map cycle guard = %v", selfRecord["self"])
	}

	// A slice that contains itself is caught as well.
	slice := make([]any, 1)
	slice[0] = slice
	nested := items(t, Dump(slice))[0].([]any)
	if len(nested) != 1 || nested[0] != "<circular>" {
		t.Fatalf("slice cycle guard = %v", nested)
	}
}
