using System.Collections;
using System.Data;
using System.Globalization;
using System.Text.Json;
using ExploringCollections;

namespace ExploringCollections.Helper.Tests;

/// <summary>
/// Verifies the helper against the envelope contract the extension relies on.
/// Run with: dotnet run --project helpers/dotnet/tests/HelperTests.csproj
/// </summary>
public static class Program
{
    private static int _failures;
    private static int _checks;

    private static void Check(string name, bool condition, string? detail = null)
    {
        _checks++;
        if (condition)
        {
            return;
        }

        _failures++;
        Console.WriteLine($"  FAIL {name}{(detail is null ? string.Empty : ": " + detail)}");
    }

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    public static int Main()
    {
        SequenceOfRecords();
        Mapping();
        RecordMode();
        Temporals();
        Numbers();
        Cycles();
        ThrowingGetter();
        FSharpOption();
        FSharpUnion();
        DataTableEnvelope();
        DataSetEnvelope();
        DepthLimit();
        OptionsRespected();

        Console.WriteLine($"{_checks} checks, {_failures} failure(s)");
        return _failures == 0 ? 0 : 1;
    }

    private static void SequenceOfRecords()
    {
        var temperatures = new List<Temperature>
        {
            new("Seoul", 21, new DateOnly(2024, 4, 1)),
            new("Lima", 19, new DateOnly(2024, 4, 2))
        };

        var json = Parse(CollectionHelper.ToJson(temperatures));
        Check("envelope marker", json.GetProperty("__ec").GetInt32() == 1);
        Check("kind sequence", json.GetProperty("kind").GetString() == "sequence");
        Check("total", json.GetProperty("total").GetInt32() == 2);

        var first = json.GetProperty("items")[0];
        Check("record city", first.GetProperty("City").GetString() == "Seoul", first.ToString());
        Check("record computed property", first.GetProperty("Feels").GetString() == "warm", first.ToString());
        Check("record dateonly", first.GetProperty("Date").GetString() == "2024-04-01", first.ToString());
    }

    private static void Mapping()
    {
        var json = Parse(CollectionHelper.ToJson(new Dictionary<string, int> { ["Seoul"] = 21, ["Lima"] = 19 }));
        Check("dictionary kind", json.GetProperty("kind").GetString() == "mapping");
        Check("dictionary total", json.GetProperty("total").GetInt32() == 2);
        Check("dictionary pairs", json.GetProperty("items")[0][0].GetString() == "Seoul", json.ToString());
        Check("dictionary value", json.GetProperty("items")[0][1].GetInt32() == 21);

        var nonGeneric = Parse(CollectionHelper.ToJson(new Hashtable { ["a"] = 1 }));
        Check("hashtable kind", nonGeneric.GetProperty("kind").GetString() == "mapping");
    }

    private static void RecordMode()
    {
        var json = Parse(CollectionHelper.ToJson(new Single("Seoul", 21)));
        Check("record kind", json.GetProperty("kind").GetString() == "record");
        Check("record total", json.GetProperty("total").GetInt32() == 1);
        Check("record fields", json.GetProperty("items")[0].GetProperty("City").GetString() == "Seoul");

        var textJson = Parse(CollectionHelper.ToJson("hello"));
        Check("string is record", textJson.GetProperty("kind").GetString() == "record");
        Check("string item", textJson.GetProperty("items")[0].GetString() == "hello");

        var nullJson = Parse(CollectionHelper.ToJson(null));
        Check("null total", nullJson.GetProperty("total").GetInt32() == 1);
        Check("null item", nullJson.GetProperty("items")[0].ValueKind == JsonValueKind.Null, nullJson.ToString());
    }

    private static void Temporals()
    {
        var json = Parse(CollectionHelper.ToJson(new object[]
        {
            new DateTime(2024, 4, 1, 12, 30, 15, DateTimeKind.Utc),
            Guid.Parse("6f9619ff-8b86-d011-b42d-00cf4fc964ff"),
            TimeSpan.FromMinutes(90),
            new DateOnly(2024, 4, 1),
            new TimeOnly(12, 30),
            DayOfWeek.Friday,
            new Uri("https://example.com/a")
        }));

        var items = json.GetProperty("items");
        Check("datetime iso", items[0].GetString() == "2024-04-01T12:30:15", items[0].GetString());
        Check("guid", items[1].GetString() == "6f9619ff-8b86-d011-b42d-00cf4fc964ff", items[1].GetString());
        Check("timespan", items[2].GetString() == "01:30:00", items[2].GetString());
        Check("dateonly", items[3].GetString() == "2024-04-01", items[3].GetString());
        Check("timeonly", items[4].GetString()?.StartsWith("12:30", StringComparison.Ordinal) == true, items[4].GetString());
        Check("enum", items[5].GetString() == "Friday", items[5].GetString());
        Check("uri", (items[6].GetString() ?? string.Empty).StartsWith("https://example.com", StringComparison.Ordinal));
    }

    private static void Numbers()
    {
        var json = Parse(CollectionHelper.ToJson(new object[]
        {
            21,
            21.5,
            double.NaN,
            double.PositiveInfinity,
            double.NegativeInfinity,
            decimal.Parse("1.05", CultureInfo.InvariantCulture),
            long.MaxValue,
            true
        }));

        var items = json.GetProperty("items");
        Check("int", items[0].GetInt32() == 21);
        Check("double", Math.Abs(items[1].GetDouble() - 21.5) < 0.0001);
        Check("nan", items[2].GetString() == "NaN", items[2].ToString());
        Check("infinity", items[3].GetString() == "Infinity");
        Check("negative infinity", items[4].GetString() == "-Infinity");
        Check("decimal", Math.Abs(items[5].GetDouble() - 1.05) < 0.0001, items[5].ToString());
        Check("long", items[6].GetInt64() == long.MaxValue);
        Check("bool", items[7].GetBoolean());
    }

    private static void Cycles()
    {
        var node = new Node { Name = "root" };
        node.Self = node;

        var json = Parse(CollectionHelper.ToJson(new[] { node }));
        Check("cycle guard", json.GetProperty("items")[0].GetProperty("Self").GetString() == "<circular>",
            json.GetProperty("items")[0].ToString());
    }

    private static void ThrowingGetter()
    {
        var json = Parse(CollectionHelper.ToJson(new List<Throwing> { new() }));
        var item = json.GetProperty("items")[0];
        Check("throwing member", item.GetProperty("Boom").GetString() == "<threw InvalidOperationException>", item.ToString());
        Check("healthy member kept", item.GetProperty("Fine").GetInt32() == 7);
    }

    private static void FSharpOption()
    {
        var some = Parse(CollectionHelper.ToJson(new[] { new Microsoft.FSharp.Core.FSharpOption<int>(21) }));
        Check("option some", some.GetProperty("items")[0].GetInt32() == 21, some.GetProperty("items")[0].ToString());

        var none = Parse(CollectionHelper.ToJson(new[] { Microsoft.FSharp.Core.FSharpOption<int>.None }));
        Check("option none", none.GetProperty("items")[0].ValueKind == JsonValueKind.Null,
            none.GetProperty("items")[0].ToString());
    }

    private static void FSharpUnion()
    {
        var json = Parse(CollectionHelper.ToJson(new List<object> { new FakeUnionWarm(21), new FakeUnionCold() }));
        var warm = json.GetProperty("items")[0];
        Check("union case", warm.GetProperty("Case").GetString() == "Warm", warm.ToString());
        Check("union field", warm.GetProperty("Item").GetInt32() == 21, warm.ToString());

        var cold = json.GetProperty("items")[1];
        Check("union case without fields", cold.GetProperty("Case").GetString() == "Cold", cold.ToString());
    }

    private static void DataTableEnvelope()
    {
        var table = new DataTable("Weather");
        table.Columns.Add("City", typeof(string));
        table.Columns.Add("DegreeCelsius", typeof(int));
        table.Rows.Add("Seoul", 21);
        table.Rows.Add("Lima", DBNull.Value);

        var json = Parse(CollectionHelper.ToJson(table));
        Check("datatable kind", json.GetProperty("kind").GetString() == "sequence", json.ToString());
        Check("datatable total", json.GetProperty("total").GetInt32() == 2);
        var first = json.GetProperty("items")[0];
        Check("datatable column", first.GetProperty("City").GetString() == "Seoul", first.ToString());
        Check("datatable number", first.GetProperty("DegreeCelsius").GetInt32() == 21);
        var second = json.GetProperty("items")[1];
        Check("datatable dbnull", second.GetProperty("DegreeCelsius").ValueKind == JsonValueKind.Null);

        var view = Parse(CollectionHelper.ToJson(table.DefaultView));
        Check("dataview rows", view.GetProperty("total").GetInt32() == 2, view.ToString());
    }

    private static void DataSetEnvelope()
    {
        var dataSet = new DataSet("Weather");
        var table = new DataTable("Temperatures");
        table.Columns.Add("City", typeof(string));
        table.Rows.Add("Seoul");
        dataSet.Tables.Add(table);

        var json = Parse(CollectionHelper.ToJson(dataSet));
        Check("dataset kind", json.GetProperty("kind").GetString() == "mapping", json.ToString());
        Check("dataset table name", json.GetProperty("items")[0][0].GetString() == "Temperatures", json.ToString());
        Check("dataset rows", json.GetProperty("items")[0][1].GetArrayLength() == 1, json.ToString());
    }

    private static void DepthLimit()
    {
        var deep = new Node { Name = "1" };
        var current = deep;
        for (var index = 2; index <= 12; index++)
        {
            current.Self = new Node { Name = index.ToString(CultureInfo.InvariantCulture) };
            current = current.Self;
        }

        var json = CollectionHelper.ToJson(deep);
        Check("deep graph is bounded", json.Length < 5000, json.Length.ToString(CultureInfo.InvariantCulture));
        Check("deep graph has depth marker", json.Contains("count=", StringComparison.Ordinal) || json.Length < 500,
            json);
    }

    private static void OptionsRespected()
    {
        var many = Enumerable.Range(0, 50).ToArray();
        var limited = Parse(CollectionHelper.ToJson(many, 4, 5));
        Check("maxItems respected", limited.GetProperty("items").GetArrayLength() == 5, limited.ToString());
        Check("total reported", limited.GetProperty("total").GetInt32() == 50);

        var pairs = Parse(CollectionHelper.ToJson(new Dictionary<string, int[]> { ["a"] = new[] { 1, 2, 3 } }));
        var pair = pairs.GetProperty("items")[0];
        Check("pair value is an array", pair[1].GetArrayLength() == 3, pair.ToString());
    }

    public sealed record Temperature(string City, int DegreeCelsius, DateOnly Date)
    {
        public string Feels => DegreeCelsius switch
        {
            < 10 => "cold",
            > 20 => "warm",
            _ => "normal"
        };
    }

    private sealed record Single(string City, int DegreeCelsius);

    private sealed class Node
    {
        public string Name { get; set; } = string.Empty;

        public Node? Self { get; set; }
    }

    private sealed class Throwing
    {
        public int Fine => 7;

        public string Boom => throw new InvalidOperationException("nope");
    }

    /// <summary>Mimics the shape the F# compiler generates for a union.</summary>
    private sealed class FakeUnionWarm
    {
        public FakeUnionWarm(int item) => Item = item;

        public int Tag => 1;

        public bool IsWarm => true;

        public bool IsCold => false;

        public int Item { get; }
    }

    private sealed class FakeUnionCold
    {
        public int Tag => 0;

        public bool IsWarm => false;

        public bool IsCold => true;
    }
}
