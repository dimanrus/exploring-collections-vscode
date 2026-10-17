using System.Diagnostics.CodeAnalysis;

namespace Microsoft.FSharp.Core;

/// <summary>
/// Minimal stand-in for FSharp.Core's option type. The helper recognizes
/// FSharpOption/FSharpValueOption by namespace and name, so this lets the option
/// handling be verified without taking a dependency on FSharp.Core.
/// </summary>
[SuppressMessage("Naming", "CA1711", Justification = "Mirrors the FSharp.Core type name.")]
public sealed class FSharpOption<T>
{
    public static readonly FSharpOption<T> None = new(default!);

    public FSharpOption(T value) => Value = value;

    public T Value { get; }
}
