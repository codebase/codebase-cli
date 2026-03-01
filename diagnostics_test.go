package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGoVetOutput(t *testing.T) {
	output := `# example.com/pkg
./main.go:42:10: undefined: foo
./main.go:55:3: unreachable code
./util.go:12:1: exported function Bar should have comment`

	diags := parseGoVetOutput(output)
	if len(diags) != 3 {
		t.Fatalf("expected 3 diagnostics, got %d", len(diags))
	}

	d := diags[0]
	if d.File != "./main.go" || d.Line != 42 || d.Column != 10 {
		t.Errorf("first diag wrong location: %s:%d:%d", d.File, d.Line, d.Column)
	}
	if d.Message != "undefined: foo" {
		t.Errorf("first diag wrong message: %s", d.Message)
	}
	if d.Severity != "error" {
		t.Errorf("first diag wrong severity: %s", d.Severity)
	}
}

func TestParseGoVetOutputEmpty(t *testing.T) {
	diags := parseGoVetOutput("")
	if len(diags) != 0 {
		t.Errorf("expected 0 diagnostics for empty output, got %d", len(diags))
	}
}

func TestParseGoVetOutputClean(t *testing.T) {
	// go vet with no issues produces no output matching the regex
	diags := parseGoVetOutput("# some package comment\n")
	if len(diags) != 0 {
		t.Errorf("expected 0 diagnostics for clean vet, got %d", len(diags))
	}
}

func TestParseTscOutput(t *testing.T) {
	output := `src/index.ts(10,5): error TS2304: Cannot find name 'foo'.
src/utils.ts(3,12): warning TS6133: 'bar' is declared but never used.
src/index.ts(25,1): error TS2345: Argument of type 'string' is not assignable.`

	diags := parseTscOutput(output)
	if len(diags) != 3 {
		t.Fatalf("expected 3 diagnostics, got %d", len(diags))
	}

	d := diags[0]
	if d.File != "src/index.ts" || d.Line != 10 || d.Column != 5 {
		t.Errorf("first diag wrong location: %s:%d:%d", d.File, d.Line, d.Column)
	}
	if d.Severity != "error" {
		t.Errorf("first diag wrong severity: %s", d.Severity)
	}
	if !strings.Contains(d.Message, "Cannot find name") {
		t.Errorf("first diag wrong message: %s", d.Message)
	}

	d2 := diags[1]
	if d2.Severity != "warning" {
		t.Errorf("second diag should be warning, got: %s", d2.Severity)
	}
}

func TestParseTscOutputEmpty(t *testing.T) {
	diags := parseTscOutput("")
	if len(diags) != 0 {
		t.Errorf("expected 0 diagnostics, got %d", len(diags))
	}
}

func TestParsePyrightOutput(t *testing.T) {
	output := `{
		"generalDiagnostics": [
			{
				"file": "main.py",
				"range": {"start": {"line": 9, "character": 4}},
				"severity": "error",
				"message": "Cannot access member 'foo'"
			},
			{
				"file": "utils.py",
				"range": {"start": {"line": 0, "character": 0}},
				"severity": "warning",
				"message": "Import 'os' is not accessed"
			}
		]
	}`

	diags := parsePyrightOutput(output)
	if len(diags) != 2 {
		t.Fatalf("expected 2 diagnostics, got %d", len(diags))
	}

	// Pyright uses 0-based lines, we convert to 1-based
	d := diags[0]
	if d.File != "main.py" || d.Line != 10 || d.Column != 5 {
		t.Errorf("first diag wrong location: %s:%d:%d", d.File, d.Line, d.Column)
	}
	if d.Severity != "error" {
		t.Errorf("first diag wrong severity: %s", d.Severity)
	}
}

func TestParsePyrightOutputInvalid(t *testing.T) {
	diags := parsePyrightOutput("not json")
	if len(diags) != 0 {
		t.Errorf("expected 0 diagnostics for invalid JSON, got %d", len(diags))
	}
}

func TestFormatDiagnosticsMessage(t *testing.T) {
	diags := []Diagnostic{
		{File: "main.go", Line: 42, Column: 10, Severity: "error", Message: "undefined: foo"},
		{File: "main.go", Line: 55, Column: 3, Severity: "error", Message: "unreachable code"},
		{File: "util.go", Line: 12, Column: 1, Severity: "warning", Message: "unused variable"},
	}

	msg := formatDiagnosticsMessage(diags)

	if !strings.Contains(msg, "Language Diagnostics") {
		t.Error("missing header")
	}
	if !strings.Contains(msg, "### main.go") {
		t.Error("missing main.go section")
	}
	if !strings.Contains(msg, "### util.go") {
		t.Error("missing util.go section")
	}
	if !strings.Contains(msg, "Line 42:10 [error]: undefined: foo") {
		t.Error("missing first diagnostic")
	}
	if !strings.Contains(msg, "Please fix these issues") {
		t.Error("missing fix instruction")
	}
}

func TestNewDiagnosticsEngineDetectsGo(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\n"), 0644)

	de := NewDiagnosticsEngine(dir)
	if !de.Enabled {
		t.Error("diagnostics should be enabled by default")
	}

	checkers := de.DetectedCheckers()
	found := false
	for _, c := range checkers {
		if c == "Go" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("Go checker not detected, got: %v", checkers)
	}
}

func TestNewDiagnosticsEngineNoCheckers(t *testing.T) {
	dir := t.TempDir()
	de := NewDiagnosticsEngine(dir)
	if len(de.checkers) != 0 {
		t.Errorf("expected no checkers for empty dir, got %d", len(de.checkers))
	}
}

func TestDiagnosticsEngineDisabled(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\n"), 0644)

	de := NewDiagnosticsEngine(dir)
	de.Enabled = false

	diags := de.CheckFiles([]string{"main.go"})
	if len(diags) != 0 {
		t.Error("disabled engine should return nil diagnostics")
	}
}

func TestDiagnosticsEngineNoMatchingChecker(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\n"), 0644)

	de := NewDiagnosticsEngine(dir)

	// .rs files have no checker
	diags := de.CheckFiles([]string{"main.rs"})
	if len(diags) != 0 {
		t.Error("should return nil for unrecognized file extension")
	}
}

func TestDetectedCheckersReturnsNames(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\n"), 0644)
	os.WriteFile(filepath.Join(dir, "tsconfig.json"), []byte("{}"), 0644)

	de := NewDiagnosticsEngine(dir)
	names := de.DetectedCheckers()

	if len(names) < 1 {
		t.Fatal("expected at least 1 checker")
	}
	// Should have Go at minimum
	hasGo := false
	for _, n := range names {
		if n == "Go" {
			hasGo = true
		}
	}
	if !hasGo {
		t.Errorf("expected Go in detected checkers, got: %v", names)
	}
}
