package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Create test files
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n"), 0644)
	os.WriteFile(filepath.Join(dir, "util.go"), []byte("package main\n\nfunc helper() string {\n\treturn \"help\"\n}\n"), 0644)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Project\n\nA test project.\n"), 0644)
	os.MkdirAll(filepath.Join(dir, "src"), 0755)
	os.WriteFile(filepath.Join(dir, "src", "app.go"), []byte("package src\n\nfunc App() {}\n"), 0644)
	os.WriteFile(filepath.Join(dir, "src", "app_test.go"), []byte("package src\n\nfunc TestApp() {}\n"), 0644)

	return dir
}

func callTool(t *testing.T, name string, args map[string]interface{}, workDir string) (string, bool) {
	t.Helper()
	argsJSON, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return ExecuteTool(name, string(argsJSON), workDir)
}

// ── read_file tests ──────────────────────────────────────────

func TestReadFile(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "read_file", map[string]interface{}{
		"path": "main.go",
	}, dir)

	if !ok {
		t.Fatalf("read_file failed: %s", output)
	}
	if !strings.Contains(output, "fmt.Println") {
		t.Error("expected file content in output")
	}
	if !strings.Contains(output, "lines total") {
		t.Errorf("expected line count in output, got: %s", output)
	}
}

func TestReadFileWithOffset(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "read_file", map[string]interface{}{
		"path":   "main.go",
		"offset": 3.0,
		"limit":  2.0,
	}, dir)

	if !ok {
		t.Fatalf("read_file failed: %s", output)
	}
	if !strings.Contains(output, "Showing lines 3-4") {
		t.Errorf("expected range in output, got: %s", output)
	}
}

func TestReadFileNotFound(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "read_file", map[string]interface{}{
		"path": "nonexistent.go",
	}, dir)

	if ok {
		t.Fatal("expected failure for nonexistent file")
	}
	if !strings.Contains(output, "not found") {
		t.Errorf("expected 'not found' error, got: %s", output)
	}
}

func TestReadFileDirectory(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "read_file", map[string]interface{}{
		"path": "src",
	}, dir)

	if ok {
		t.Fatal("expected failure for directory")
	}
	if !strings.Contains(output, "directory") {
		t.Errorf("expected directory error, got: %s", output)
	}
}

// ── write_file tests ─────────────────────────────────────────

func TestWriteFileNew(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "write_file", map[string]interface{}{
		"path":    "new_file.go",
		"content": "package main\n",
	}, dir)

	if !ok {
		t.Fatalf("write_file failed: %s", output)
	}
	if !strings.Contains(output, "Created") {
		t.Errorf("expected 'Created', got: %s", output)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "new_file.go"))
	if string(data) != "package main\n" {
		t.Errorf("file content mismatch: %s", string(data))
	}
}

func TestWriteFileOverwrite(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "write_file", map[string]interface{}{
		"path":    "main.go",
		"content": "package main\n// overwritten\n",
	}, dir)

	if !ok {
		t.Fatalf("write_file failed: %s", output)
	}
	if !strings.Contains(output, "Updated") {
		t.Errorf("expected 'Updated', got: %s", output)
	}
}

func TestWriteFileCreatesDir(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "write_file", map[string]interface{}{
		"path":    "deep/nested/file.txt",
		"content": "hello\n",
	}, dir)

	if !ok {
		t.Fatalf("write_file failed: %s", output)
	}

	_, err := os.Stat(filepath.Join(dir, "deep", "nested", "file.txt"))
	if err != nil {
		t.Error("nested file not created")
	}
}

// ── edit_file tests ──────────────────────────────────────────

func TestEditFile(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "edit_file", map[string]interface{}{
		"path":     "main.go",
		"old_text": "fmt.Println(\"hello\")",
		"new_text": "fmt.Println(\"world\")",
	}, dir)

	if !ok {
		t.Fatalf("edit_file failed: %s", output)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if !strings.Contains(string(data), "world") {
		t.Error("edit not applied")
	}
}

func TestEditFileNotFound(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "edit_file", map[string]interface{}{
		"path":     "main.go",
		"old_text": "nonexistent text",
		"new_text": "replacement",
	}, dir)

	if ok {
		t.Fatal("expected failure for nonexistent text")
	}
	if !strings.Contains(output, "not found") {
		t.Errorf("expected 'not found' error, got: %s", output)
	}
	// Should include file preview
	if !strings.Contains(output, "File preview") {
		t.Errorf("expected file preview in error, got: %s", output)
	}
}

func TestEditFileMultipleMatches(t *testing.T) {
	dir := setupTestDir(t)

	// Write a file with duplicate lines
	os.WriteFile(filepath.Join(dir, "dups.go"), []byte("a\na\na\n"), 0644)

	output, ok := callTool(t, "edit_file", map[string]interface{}{
		"path":     "dups.go",
		"old_text": "a",
		"new_text": "b",
	}, dir)

	if ok {
		t.Fatal("expected failure for multiple matches")
	}
	if !strings.Contains(output, "3 times") {
		t.Errorf("expected occurrence count, got: %s", output)
	}
}

// ── multi_edit tests ─────────────────────────────────────────

func TestMultiEdit(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "multi_edit", map[string]interface{}{
		"edits": []interface{}{
			map[string]interface{}{
				"path":     "main.go",
				"old_text": "fmt.Println(\"hello\")",
				"new_text": "fmt.Println(\"world\")",
			},
			map[string]interface{}{
				"path":     "util.go",
				"old_text": "return \"help\"",
				"new_text": "return \"assist\"",
			},
		},
	}, dir)

	if !ok {
		t.Fatalf("multi_edit failed: %s", output)
	}
	if !strings.Contains(output, "2 ok") {
		t.Errorf("expected '2 ok', got: %s", output)
	}

	data1, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if !strings.Contains(string(data1), "world") {
		t.Error("edit 1 not applied")
	}
	data2, _ := os.ReadFile(filepath.Join(dir, "util.go"))
	if !strings.Contains(string(data2), "assist") {
		t.Error("edit 2 not applied")
	}
}

func TestMultiEditRollback(t *testing.T) {
	dir := setupTestDir(t)

	// Second edit to the same file should fail, rolling back the first
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("line1\nline2\nline3\n"), 0644)

	_, ok := callTool(t, "multi_edit", map[string]interface{}{
		"edits": []interface{}{
			map[string]interface{}{
				"path":     "test.txt",
				"old_text": "line1",
				"new_text": "modified1",
			},
			map[string]interface{}{
				"path":     "test.txt",
				"old_text": "nonexistent",
				"new_text": "anything",
			},
		},
	}, dir)

	if ok {
		t.Fatal("expected failure when edit in same file fails")
	}

	// File should be unchanged (rolled back)
	data, _ := os.ReadFile(filepath.Join(dir, "test.txt"))
	if strings.Contains(string(data), "modified1") {
		t.Error("file should have been rolled back but edit persisted")
	}
}

// ── list_files tests ─────────────────────────────────────────

func TestListFilesRoot(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "list_files", map[string]interface{}{}, dir)

	if !ok {
		t.Fatalf("list_files failed: %s", output)
	}
	if !strings.Contains(output, "main.go") {
		t.Errorf("expected main.go in listing, got: %s", output)
	}
	if !strings.Contains(output, "[dir]") {
		t.Errorf("expected directory markers, got: %s", output)
	}
}

func TestListFilesSubdir(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "list_files", map[string]interface{}{
		"path": "src",
	}, dir)

	if !ok {
		t.Fatalf("list_files failed: %s", output)
	}
	if !strings.Contains(output, "app.go") {
		t.Errorf("expected app.go in listing, got: %s", output)
	}
}

func TestListFilesGlob(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "list_files", map[string]interface{}{
		"pattern": "*.go",
	}, dir)

	if !ok {
		t.Fatalf("list_files failed: %s", output)
	}
	if !strings.Contains(output, "main.go") {
		t.Errorf("expected main.go in glob results, got: %s", output)
	}
}

func TestListFilesGlobRecursive(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "list_files", map[string]interface{}{
		"pattern": "**/*.go",
	}, dir)

	if !ok {
		t.Fatalf("list_files failed: %s", output)
	}
	// Should find files in subdirectories
	if !strings.Contains(output, "app.go") {
		t.Errorf("expected app.go in recursive glob results, got: %s", output)
	}
}

func TestListFilesNotFound(t *testing.T) {
	dir := setupTestDir(t)

	_, ok := callTool(t, "list_files", map[string]interface{}{
		"path": "nonexistent",
	}, dir)

	if ok {
		t.Fatal("expected failure for nonexistent directory")
	}
}

// ── search_files tests ──────────────────────────────────────

func TestSearchFiles(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "search_files", map[string]interface{}{
		"pattern": "func main",
	}, dir)

	if !ok {
		t.Fatalf("search_files failed: %s", output)
	}
	if !strings.Contains(output, "main.go") {
		t.Errorf("expected main.go in search results, got: %s", output)
	}
}

func TestSearchFilesNoResults(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "search_files", map[string]interface{}{
		"pattern": "xyznonexistentpattern123",
	}, dir)

	if !ok {
		t.Fatalf("search_files should succeed even with no results, got: %s", output)
	}
	if !strings.Contains(output, "No matches") {
		t.Errorf("expected 'No matches', got: %s", output)
	}
}

func TestSearchFilesWithInclude(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "search_files", map[string]interface{}{
		"pattern": "func",
		"include": "*.go",
	}, dir)

	if !ok {
		t.Fatalf("search_files failed: %s", output)
	}
	// Should not include README.md results
	if strings.Contains(output, "README") {
		t.Errorf("expected only .go files, got: %s", output)
	}
}

// ── shell tests ──────────────────────────────────────────────

func TestShell(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "shell", map[string]interface{}{
		"command": "echo hello",
	}, dir)

	if !ok {
		t.Fatalf("shell failed: %s", output)
	}
	if !strings.Contains(output, "hello") {
		t.Errorf("expected 'hello' in output, got: %s", output)
	}
	if !strings.Contains(output, "Exit code: 0") {
		t.Errorf("expected exit code 0, got: %s", output)
	}
}

func TestShellFailure(t *testing.T) {
	dir := setupTestDir(t)

	output, ok := callTool(t, "shell", map[string]interface{}{
		"command": "exit 1",
	}, dir)

	if ok {
		t.Fatal("expected failure for exit 1")
	}
	if !strings.Contains(output, "Exit code") {
		t.Errorf("expected exit code in output, got: %s", output)
	}
}

// ── safePath tests ───────────────────────────────────────────

func TestSafePathTraversal(t *testing.T) {
	dir := setupTestDir(t)

	_, ok := callTool(t, "read_file", map[string]interface{}{
		"path": "../../etc/passwd",
	}, dir)

	if ok {
		t.Fatal("expected safePath to block directory traversal")
	}
}

// ── parallelSafe tests ──────────────────────────────────────

func TestParallelSafeTools(t *testing.T) {
	if !IsParallelSafe("read_file") {
		t.Error("read_file should be parallel-safe")
	}
	if !IsParallelSafe("list_files") {
		t.Error("list_files should be parallel-safe")
	}
	if !IsParallelSafe("search_files") {
		t.Error("search_files should be parallel-safe")
	}
	if IsParallelSafe("write_file") {
		t.Error("write_file should NOT be parallel-safe")
	}
	if IsParallelSafe("edit_file") {
		t.Error("edit_file should NOT be parallel-safe")
	}
	if IsParallelSafe("shell") {
		t.Error("shell should NOT be parallel-safe")
	}
}
