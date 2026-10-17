using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace ExploringCollections
{
    /// <summary>
    /// Serializes an arbitrary object graph into the collection envelope the
    /// Exploring Collections extension understands:
    /// <code>
    /// { "__ec": 1, "kind": "sequence" | "mapping" | "record", "total": 14, "items": [ ... ] }
    /// </code>
    /// The helper targets netstandard2.0 so the same assembly can be loaded into
    /// .NET Framework, .NET Core and .NET 5+ debuggees. ADO.NET support is
    /// implemented through reflection, which keeps the helper dependency free.
    /// </summary>
    public static class CollectionHelper
    {
        private const int DefaultMaxDepth = 8;
        private const int DefaultMaxItems = 200000;
        private const int MaxStringLength = 65536;

        /// <summary>Serializes <paramref name="value"/> with the default limits.</summary>
        public static string ToJson(object value)
        {
            return ToJson(value, DefaultMaxDepth, DefaultMaxItems);
        }

        /// <summary>Serializes <paramref name="value"/> into the envelope JSON.</summary>
        public static string ToJson(object value, int maxDepth, int maxItems)
        {
            var context = new SerializationContext(
                maxDepth > 0 ? maxDepth : DefaultMaxDepth,
                maxItems > 0 ? maxItems : DefaultMaxItems);
            return context.Serialize(value);
        }

        /// <summary>Returns a short, human readable description of a value.</summary>
        public static string Describe(object value)
        {
            if (value == null)
            {
                return "null";
            }

            if (value is string text)
            {
                return text.Length > 120 ? text.Substring(0, 119) + "..." : text;
            }

            if (value is ICollection collection)
            {
                return value.GetType().Name + "[" + collection.Count.ToString(CultureInfo.InvariantCulture) + "]";
            }

            var type = value.GetType();
            return type.FullName ?? type.Name;
        }

        private sealed class SerializationContext
        {
            private readonly StringBuilder _builder = new StringBuilder(4096);
            private readonly HashSet<object> _visited = new HashSet<object>(ReferenceComparer.Instance);
            private readonly int _maxDepth;
            private readonly int _maxItems;

            internal SerializationContext(int maxDepth, int maxItems)
            {
                _maxDepth = maxDepth;
                _maxItems = maxItems;
            }

            internal string Serialize(object value)
            {
                var dataSet = Tables.TryCreateDataSet(value, _maxItems);
                if (dataSet != null)
                {
                    WriteEnvelope("mapping", dataSet.Count, () => WriteDataSet(dataSet));
                    return _builder.ToString();
                }

                var table = Tables.TryCreateTable(value, _maxItems);
                if (table != null)
                {
                    WriteEnvelope("sequence", table.RowCount, () => WriteTableRows(table, _maxDepth - 1));
                    return _builder.ToString();
                }

                var pairs = Pairs.TryEnumerate(value, out var pairTotal);
                if (pairs != null)
                {
                    WriteEnvelope("mapping", pairTotal, () => WritePairs(pairs));
                    return _builder.ToString();
                }

                if (Sequences.IsSequence(value, out var sequenceTotal))
                {
                    WriteEnvelope("sequence", sequenceTotal, () => WriteItems(Sequences.Enumerate(value)));
                    return _builder.ToString();
                }

                WriteEnvelope("record", 1, () => WriteValue(value, _maxDepth - 1));
                return _builder.ToString();
            }

            private void WriteEnvelope(string kind, long? total, Action body)
            {
                _builder.Append("{\"__ec\":1,\"kind\":");
                WriteString(kind);
                _builder.Append(",\"total\":");
                if (total.HasValue)
                {
                    _builder.Append(total.Value.ToString(CultureInfo.InvariantCulture));
                }
                else
                {
                    _builder.Append("null");
                }

                _builder.Append(",\"items\":[");
                body();
                _builder.Append("]}");
            }

            private void WriteDataSet(IEnumerable<Tables.TableInfo> dataSet)
            {
                var first = true;
                foreach (var table in dataSet)
                {
                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    _builder.Append('[');
                    WriteString(table.Name);
                    _builder.Append(",[");
                    WriteTableRows(table, _maxDepth - 2);
                    _builder.Append("]]");
                }
            }

            private void WriteTableRows(Tables.TableInfo table, int depth)
            {
                var first = true;
                var written = 0;
                foreach (var row in table.EnumerateRows())
                {
                    if (written++ >= _maxItems)
                    {
                        break;
                    }

                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteObjectMembers(row, depth);
                }
            }

            private void WritePairs(IEnumerable<KeyValuePair<object, object>> pairs)
            {
                var written = 0;
                var first = true;
                foreach (var pair in pairs)
                {
                    if (written++ >= _maxItems)
                    {
                        break;
                    }

                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    _builder.Append('[');
                    WriteValue(pair.Key, 1);
                    _builder.Append(',');
                    WriteValue(pair.Value, _maxDepth - 2);
                    _builder.Append(']');
                }
            }

            private void WriteItems(IEnumerable<object> values)
            {
                var written = 0;
                var first = true;
                foreach (var item in values)
                {
                    if (written++ >= _maxItems)
                    {
                        break;
                    }

                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteValue(item, _maxDepth - 1);
                }
            }

            private void WriteValue(object value, int depth)
            {
                if (value == null)
                {
                    _builder.Append("null");
                    return;
                }

                if (value is string text)
                {
                    WriteString(Truncate(text));
                    return;
                }

                if (value is char character)
                {
                    WriteString(character.ToString());
                    return;
                }

                if (value is bool boolean)
                {
                    _builder.Append(boolean ? "true" : "false");
                    return;
                }

                var type = value.GetType();

                if (TryWriteNumber(value, type) || TryWriteTemporal(value, type))
                {
                    return;
                }

                if (TryWriteOption(value, type, depth) || TryWriteUnion(value, type, depth))
                {
                    return;
                }

                if (depth <= 0)
                {
                    WritePlaceholder(value, type);
                    return;
                }

                var trackCycle = !type.IsValueType;
                if (trackCycle && !_visited.Add(value))
                {
                    WriteString("<circular>");
                    return;
                }

                try
                {
                    var pairs = Pairs.TryEnumerate(value, out _);
                    if (pairs != null)
                    {
                        WritePairsObject(pairs, depth);
                        return;
                    }

                    if (Sequences.IsSequence(value, out _))
                    {
                        WriteItemsArray(Sequences.Enumerate(value), depth);
                        return;
                    }

                    _builder.Append('{');
                    WriteMemberValues(value, Members.For(type), depth);
                    _builder.Append('}');
                }
                finally
                {
                    if (trackCycle)
                    {
                        _visited.Remove(value);
                    }
                }
            }

            private void WritePairsObject(IEnumerable<KeyValuePair<object, object>> pairs, int depth)
            {
                _builder.Append('{');
                var written = 0;
                var first = true;
                foreach (var pair in pairs)
                {
                    if (written++ >= _maxItems)
                    {
                        break;
                    }

                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteString(Convert.ToString(pair.Key, CultureInfo.InvariantCulture) ?? string.Empty);
                    _builder.Append(':');
                    WriteValue(pair.Value, depth - 1);
                }

                _builder.Append('}');
            }

            private void WriteItemsArray(IEnumerable<object> values, int depth)
            {
                _builder.Append('[');
                var written = 0;
                var first = true;
                foreach (var item in values)
                {
                    if (written++ >= _maxItems)
                    {
                        break;
                    }

                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteValue(item, depth - 1);
                }

                _builder.Append(']');
            }

            private void WriteObjectMembers(IDictionary<string, object> values, int depth)
            {
                _builder.Append('{');
                var first = true;
                foreach (var pair in values)
                {
                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteString(pair.Key);
                    _builder.Append(':');
                    WriteValue(pair.Value, depth);
                }

                _builder.Append('}');
            }

            private void WriteMemberValues(
                object value,
                IEnumerable<Members.Accessor> members,
                int depth,
                bool leadingComma = false
            )
            {
                var first = !leadingComma;
                foreach (var member in members)
                {
                    if (!first)
                    {
                        _builder.Append(',');
                    }

                    first = false;
                    WriteString(member.Name);
                    _builder.Append(':');

                    object memberValue;
                    try
                    {
                        memberValue = member.Read(value);
                    }
                    catch (Exception error)
                    {
                        // PropertyInfo.GetValue wraps getter exceptions.
                        var real = error.InnerException ?? error;
                        WriteString("<threw " + real.GetType().Name + ">");
                        continue;
                    }

                    WriteValue(memberValue, depth - 1);
                }
            }

            private void WritePlaceholder(object value, Type type)
            {
                if (value is ICollection collection)
                {
                    WriteString(
                        "<" + type.Name + " count=" + collection.Count.ToString(CultureInfo.InvariantCulture) + ">");
                    return;
                }

                WriteString("<" + (type.FullName ?? type.Name) + ">");
            }

            private bool TryWriteNumber(object value, Type type)
            {
                // Enums report the underlying integral TypeCode, but writing them
                // as numbers would lose the member name.
                if (type.IsEnum)
                {
                    return false;
                }

                switch (Type.GetTypeCode(type))
                {
                    case TypeCode.Byte:
                    case TypeCode.SByte:
                    case TypeCode.Int16:
                    case TypeCode.UInt16:
                    case TypeCode.Int32:
                    case TypeCode.UInt32:
                    case TypeCode.Int64:
                    case TypeCode.UInt64:
                    case TypeCode.Decimal:
                        _builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                        return true;
                    case TypeCode.Single:
                    case TypeCode.Double:
                        WriteFloatingPoint(Convert.ToDouble(value, CultureInfo.InvariantCulture));
                        return true;
                    default:
                        return false;
                }
            }

            private void WriteFloatingPoint(double number)
            {
                if (double.IsNaN(number))
                {
                    WriteString("NaN");
                }
                else if (double.IsPositiveInfinity(number))
                {
                    WriteString("Infinity");
                }
                else if (double.IsNegativeInfinity(number))
                {
                    WriteString("-Infinity");
                }
                else
                {
                    _builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                }
            }

            private bool TryWriteTemporal(object value, Type type)
            {
                if (value is DateTime dateTime)
                {
                    WriteString(dateTime.ToString("yyyy-MM-ddTHH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture));
                    return true;
                }

                if (value is DateTimeOffset offset)
                {
                    WriteString(offset.ToString("yyyy-MM-ddTHH:mm:ss.FFFFFFFK", CultureInfo.InvariantCulture));
                    return true;
                }

                if (value is TimeSpan span)
                {
                    WriteString(span.ToString());
                    return true;
                }

                if (value is Guid guid)
                {
                    WriteString(guid.ToString("D"));
                    return true;
                }

                if (value is Uri uri)
                {
                    WriteString(uri.ToString());
                    return true;
                }

                if (value is Enum)
                {
                    WriteString(value.ToString());
                    return true;
                }

                // DateOnly and TimeOnly only exist on .NET 6+, so they are matched
                // by name to keep the helper compatible with netstandard2.0.
                var fullName = type.FullName;
                if (fullName == "System.DateOnly" || fullName == "System.TimeOnly")
                {
                    var formatted = (value as IFormattable)?.ToString("O", CultureInfo.InvariantCulture);
                    WriteString(formatted ?? value.ToString());
                    return true;
                }

                return false;
            }

            private bool TryWriteOption(object value, Type type, int depth)
            {
                if (!type.IsGenericType)
                {
                    return false;
                }

                var definition = type.GetGenericTypeDefinition();
                var name = definition.FullName ?? definition.Name;
                var isOption =
                    name.StartsWith("Microsoft.FSharp.Core.FSharpOption", StringComparison.Ordinal) ||
                    name.StartsWith("Microsoft.FSharp.Core.FSharpValueOption", StringComparison.Ordinal);
                if (!isOption)
                {
                    return false;
                }

                // `None` (FSharpOption) and `ValueNone` (FSharpValueOption) are
                // singletons, so identity comparison distinguishes them from
                // `Some(default(T))`.
                var noneValue = ReadStaticSingleton(type);
                if (noneValue != null && ReferenceEquals(noneValue, value))
                {
                    _builder.Append("null");
                    return true;
                }

                object inner = null;
                var valueProperty = type.GetProperty("Value");
                if (valueProperty != null)
                {
                    try
                    {
                        inner = valueProperty.GetValue(value, null);
                    }
                    catch (Exception)
                    {
                        inner = null;
                    }
                }

                if (inner == null)
                {
                    _builder.Append("null");
                    return true;
                }

                WriteValue(inner, depth);
                return true;
            }

            private static object ReadStaticSingleton(Type type)
            {
                const BindingFlags flags = BindingFlags.Public | BindingFlags.Static;
                foreach (var memberName in new[] { "None", "ValueNone" })
                {
                    var property = type.GetProperty(memberName, flags);
                    if (property != null && property.GetIndexParameters().Length == 0)
                    {
                        try
                        {
                            return property.GetValue(null, null);
                        }
                        catch (Exception)
                        {
                            continue;
                        }
                    }

                    var field = type.GetField(memberName, flags);
                    if (field != null)
                    {
                        try
                        {
                            return field.GetValue(null);
                        }
                        catch (Exception)
                        {
                            continue;
                        }
                    }
                }

                return null;
            }

            /// <summary>
            /// Renders F# discriminated unions as <c>{ "Case": "Warm", ... }</c>,
            /// which reads far better than the compiler generated members.
            /// </summary>
            private bool TryWriteUnion(object value, Type type, int depth)
            {
                if (type.IsEnum)
                {
                    return false;
                }

                var tagProperty = type.GetProperty("Tag", BindingFlags.Public | BindingFlags.Instance);
                if (tagProperty == null || tagProperty.PropertyType != typeof(int))
                {
                    return false;
                }

                var caseProperties = type
                    .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                    .Where(property =>
                        property.PropertyType == typeof(bool) &&
                        property.Name.StartsWith("Is", StringComparison.Ordinal) &&
                        property.GetIndexParameters().Length == 0)
                    .ToArray();

                if (caseProperties.Length == 0)
                {
                    return false;
                }

                string caseName = null;
                foreach (var property in caseProperties)
                {
                    try
                    {
                        if ((bool)property.GetValue(value, null))
                        {
                            caseName = property.Name.Substring(2);
                            break;
                        }
                    }
                    catch (Exception)
                    {
                        // Keep looking for the matching case.
                    }
                }

                if (caseName == null)
                {
                    return false;
                }

                var fields = Members
                    .For(type)
                    .Where(member => member.Name != "Tag" && !member.Name.StartsWith("Is", StringComparison.Ordinal));

                _builder.Append("{\"Case\":");
                WriteString(caseName);
                WriteMemberValues(value, fields, depth, leadingComma: true);
                _builder.Append('}');
                return true;
            }

            private void WriteString(string value)
            {
                _builder.Append('"');
                for (var index = 0; index < value.Length; index++)
                {
                    var character = value[index];
                    switch (character)
                    {
                        case '"':
                            _builder.Append("\\\"");
                            break;
                        case '\\':
                            _builder.Append("\\\\");
                            break;
                        case '\b':
                            _builder.Append("\\b");
                            break;
                        case '\f':
                            _builder.Append("\\f");
                            break;
                        case '\n':
                            _builder.Append("\\n");
                            break;
                        case '\r':
                            _builder.Append("\\r");
                            break;
                        case '\t':
                            _builder.Append("\\t");
                            break;
                        default:
                            if (character < ' ' || character == '\u2028' || character == '\u2029')
                            {
                                _builder.Append("\\u")
                                    .Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                            }
                            else
                            {
                                _builder.Append(character);
                            }

                            break;
                    }
                }

                _builder.Append('"');
            }

            private static string Truncate(string value)
            {
                return value.Length <= MaxStringLength ? value : value.Substring(0, MaxStringLength) + "...";
            }
        }

        /// <summary>Reference based comparer used to detect cycles.</summary>
        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            internal static readonly ReferenceComparer Instance = new ReferenceComparer();

            bool IEqualityComparer<object>.Equals(object x, object y)
            {
                return ReferenceEquals(x, y);
            }

            int IEqualityComparer<object>.GetHashCode(object obj)
            {
                return RuntimeHelpers.GetHashCode(obj);
            }
        }

        /// <summary>Shared helpers for dictionaries and key/value enumerables.</summary>
        private static class Pairs
        {
            internal static IEnumerable<KeyValuePair<object, object>> TryEnumerate(object value, out long? total)
            {
                total = null;
                if (value == null || value is string)
                {
                    return null;
                }

                if (value is IDictionary dictionary)
                {
                    total = dictionary.Count;
                    return EnumerateDictionary(dictionary);
                }

                if (!IsKeyValueEnumerable(value.GetType()) || !(value is IEnumerable enumerable))
                {
                    return null;
                }

                if (value is ICollection collection)
                {
                    total = collection.Count;
                }

                return EnumeratePairs(enumerable);
            }

            internal static bool IsKeyValueEnumerable(Type type)
            {
                if (IsKeyValueEnumerableType(type))
                {
                    return true;
                }

                foreach (var candidate in type.GetInterfaces())
                {
                    if (IsKeyValueEnumerableType(candidate))
                    {
                        return true;
                    }
                }

                return false;
            }

            private static bool IsKeyValueEnumerableType(Type type)
            {
                if (!type.IsGenericType || type.GetGenericTypeDefinition() != typeof(IEnumerable<>))
                {
                    return false;
                }

                var argument = type.GetGenericArguments()[0];
                return argument.IsGenericType && argument.GetGenericTypeDefinition() == typeof(KeyValuePair<,>);
            }

            private static IEnumerable<KeyValuePair<object, object>> EnumerateDictionary(IDictionary dictionary)
            {
                foreach (DictionaryEntry entry in dictionary)
                {
                    yield return new KeyValuePair<object, object>(entry.Key, entry.Value);
                }
            }

            private static IEnumerable<KeyValuePair<object, object>> EnumeratePairs(IEnumerable enumerable)
            {
                foreach (var item in enumerable)
                {
                    if (item == null)
                    {
                        continue;
                    }

                    var type = item.GetType();
                    var keyProperty = type.GetProperty("Key");
                    var valueProperty = type.GetProperty("Value");
                    if (keyProperty == null || valueProperty == null)
                    {
                        continue;
                    }

                    yield return new KeyValuePair<object, object>(
                        keyProperty.GetValue(item, null),
                        valueProperty.GetValue(item, null));
                }
            }
        }

        /// <summary>Shared helpers for sequences.</summary>
        private static class Sequences
        {
            internal static bool IsSequence(object value, out long? total)
            {
                total = null;
                if (value == null ||
                    value is string ||
                    value is IDictionary ||
                    Pairs.IsKeyValueEnumerable(value.GetType()))
                {
                    return false;
                }

                if (value is ICollection collection)
                {
                    total = collection.Count;
                    return true;
                }

                return value is IEnumerable;
            }

            internal static IEnumerable<object> Enumerate(object value)
            {
                if (!(value is IEnumerable enumerable))
                {
                    yield break;
                }

                foreach (var item in enumerable)
                {
                    yield return item;
                }
            }
        }

        /// <summary>Reflection based member access with per type caching.</summary>
        private static class Members
        {
            private static readonly ConcurrentDictionary<Type, Accessor[]> Cache =
                new ConcurrentDictionary<Type, Accessor[]>();

            internal static Accessor[] For(Type type)
            {
                return Cache.GetOrAdd(type, Build);
            }

            private static Accessor[] Build(Type type)
            {
                var members = new List<Accessor>();
                var seen = new HashSet<string>(StringComparer.Ordinal);

                foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!property.CanRead ||
                        property.GetIndexParameters().Length > 0 ||
                        property.GetMethod == null ||
                        property.GetMethod.IsStatic ||
                        ShouldSkip(property.Name) ||
                        !seen.Add(property.Name))
                    {
                        continue;
                    }

                    members.Add(new Accessor(property));
                }

                foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (field.IsStatic || ShouldSkip(field.Name) || !seen.Add(field.Name))
                    {
                        continue;
                    }

                    members.Add(new Accessor(field));
                }

                if (members.Count == 0)
                {
                    var valueProperty = type.GetProperty("Value");
                    if (valueProperty != null && valueProperty.CanRead)
                    {
                        members.Add(new Accessor(valueProperty));
                    }
                }

                // F# lists expose the head as `Head` and the tail as `Tail`: for a
                // table view the tail is recursion noise, so it is dropped.
                if (members.Any(member => member.Name == "Head") && members.Any(member => member.Name == "Tail"))
                {
                    members.RemoveAll(member => member.Name == "Tail" || member.Name == "IsEmpty");
                }

                return members.ToArray();
            }

            private static bool ShouldSkip(string name)
            {
                // `EqualityContract` is generated by C# records and carries no data.
                return name == "EqualityContract" ||
                       name.StartsWith("get_", StringComparison.Ordinal) ||
                       name.StartsWith("set_", StringComparison.Ordinal) ||
                       name.StartsWith("add_", StringComparison.Ordinal) ||
                       name.StartsWith("remove_", StringComparison.Ordinal);
            }

            internal sealed class Accessor
            {
                private readonly PropertyInfo _property;
                private readonly FieldInfo _field;

                internal Accessor(PropertyInfo property)
                {
                    _property = property;
                    Name = property.Name;
                }

                internal Accessor(FieldInfo field)
                {
                    _field = field;
                    Name = field.Name;
                }

                internal string Name { get; }

                internal object Read(object instance)
                {
                    return _property != null ? _property.GetValue(instance, null) : _field.GetValue(instance);
                }
            }
        }

        /// <summary>
        /// Reflection based view over ADO.NET tables, kept separate so that the
        /// helper has no compile time dependency on System.Data.
        /// </summary>
        private static class Tables
        {
            internal static List<TableInfo> TryCreateDataSet(object value, int maxItems)
            {
                if (value == null || value.GetType().Name != "DataSet")
                {
                    return null;
                }

                if (!(value.GetType().GetProperty("Tables")?.GetValue(value, null) is IEnumerable tables))
                {
                    return null;
                }

                var result = new List<TableInfo>();
                foreach (var table in tables)
                {
                    var info = TryCreateTable(table, maxItems);
                    if (info != null)
                    {
                        result.Add(info);
                    }

                    if (result.Count >= 64)
                    {
                        break;
                    }
                }

                return result;
            }

            internal static TableInfo TryCreateTable(object value, int maxItems)
            {
                if (value == null)
                {
                    return null;
                }

                var type = value.GetType();
                var typeName = type.Name;
                if (typeName != "DataTable" && typeName != "DataView")
                {
                    return null;
                }

                var table = typeName == "DataView" ? type.GetProperty("Table")?.GetValue(value, null) : value;
                if (table == null)
                {
                    return null;
                }

                var tableType = table.GetType();
                var rows = tableType.GetProperty("Rows")?.GetValue(table, null) as IEnumerable;
                var columns = tableType.GetProperty("Columns")?.GetValue(table, null) as IEnumerable;
                if (rows == null || columns == null)
                {
                    return null;
                }

                var names = new List<string>();
                foreach (var column in columns)
                {
                    if (column == null)
                    {
                        continue;
                    }

                    var name = column.GetType().GetProperty("ColumnName")?.GetValue(column, null) as string;
                    names.Add(name ?? "Column" + names.Count.ToString(CultureInfo.InvariantCulture));
                    if (names.Count >= 4096)
                    {
                        break;
                    }
                }

                var rowCount = rows is ICollection collection ? collection.Count : CountRows(rows, maxItems);
                var tableName = tableType.GetProperty("TableName")?.GetValue(table, null) as string;
                return new TableInfo(rows, tableName ?? typeName, names, rowCount);
            }

            private static int CountRows(IEnumerable rows, int maxItems)
            {
                var count = 0;
                foreach (var _ in rows)
                {
                    count++;
                    if (count >= maxItems)
                    {
                        break;
                    }
                }

                return count;
            }

            internal sealed class TableInfo
            {
                private readonly IEnumerable _rows;
                private readonly IReadOnlyList<string> _columns;

                internal TableInfo(IEnumerable rows, string name, IReadOnlyList<string> columns, int rowCount)
                {
                    _rows = rows;
                    _columns = columns;
                    Name = name;
                    RowCount = rowCount;
                }

                internal string Name { get; }

                internal int RowCount { get; }

                internal IEnumerable<Dictionary<string, object>> EnumerateRows()
                {
                    var indexerCache = new Dictionary<Type, PropertyInfo>();
                    foreach (var row in _rows)
                    {
                        if (row == null)
                        {
                            continue;
                        }

                        var rowType = row.GetType();
                        if (!indexerCache.TryGetValue(rowType, out var indexer))
                        {
                            indexer = rowType.GetProperty("Item", new[] { typeof(string) });
                            indexerCache[rowType] = indexer;
                        }

                        var values = new Dictionary<string, object>(_columns.Count);
                        foreach (var column in _columns)
                        {
                            object cell = null;
                            try
                            {
                                cell = indexer?.GetValue(row, new object[] { column });
                                if (cell != null && cell.GetType().Name == "DBNull")
                                {
                                    cell = null;
                                }
                            }
                            catch (Exception error)
                            {
                                cell = "<threw " + error.GetType().Name + ">";
                            }

                            values[column] = cell;
                        }

                        yield return values;
                    }
                }
            }
        }
    }
}
