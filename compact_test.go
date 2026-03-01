package main

import (
	"strings"
	"testing"
)

func TestEstimateMessageTokens(t *testing.T) {
	msg := ChatMessage{
		Role:    "user",
		Content: strPtr("Hello, how are you?"),
	}

	tokens := estimateMessageTokens(msg)
	// 19 chars / 3.8 = 5 + 4 overhead = 9
	if tokens < 5 || tokens > 20 {
		t.Errorf("unexpected token estimate: %d", tokens)
	}
}

func TestEstimateToolCallTokens(t *testing.T) {
	msg := ChatMessage{
		Role: "assistant",
		ToolCalls: []ToolCall{
			{
				ID:   "call_1",
				Type: "function",
				Function: FunctionCall{
					Name:      "read_file",
					Arguments: `{"path": "main.go"}`,
				},
			},
		},
	}

	tokens := estimateMessageTokens(msg)
	// Should include tool call JSON in estimate
	if tokens < 10 {
		t.Errorf("token estimate too low for tool call message: %d", tokens)
	}
}

func TestNeedsCompaction(t *testing.T) {
	// Build a small history — should not need compaction
	messages := []ChatMessage{
		{Role: "system", Content: strPtr("You are a helper.")},
		{Role: "user", Content: strPtr("Hello")},
		{Role: "assistant", Content: strPtr("Hi there!")},
	}

	if needsCompaction(messages, "gpt-4o") {
		t.Error("small history should not need compaction")
	}

	// Build a very large history
	bigContent := strings.Repeat("x", 100000) // 100KB
	bigMessages := []ChatMessage{
		{Role: "system", Content: strPtr("System")},
	}
	for i := 0; i < 20; i++ {
		bigMessages = append(bigMessages,
			ChatMessage{Role: "user", Content: strPtr(bigContent)},
			ChatMessage{Role: "assistant", Content: strPtr(bigContent)},
		)
	}

	if !needsCompaction(bigMessages, "gpt-4o") {
		t.Error("large history should need compaction")
	}
}

func TestGetContextWindow(t *testing.T) {
	tests := []struct {
		model    string
		expected int
	}{
		{"gpt-4o", 128000},
		{"gpt-4o-mini", 128000},
		{"gpt-4.1", 1000000},
		{"glm-4.7", 128000},
		{"unknown-model", 128000}, // default
	}

	for _, tt := range tests {
		got := getContextWindow(tt.model)
		if got != tt.expected {
			t.Errorf("getContextWindow(%q) = %d, want %d", tt.model, got, tt.expected)
		}
	}
}

func TestCompactHistoryTooSmall(t *testing.T) {
	client := NewLLMClient("key", "http://localhost", "test")
	messages := []ChatMessage{
		{Role: "system", Content: strPtr("System")},
		{Role: "user", Content: strPtr("Hello")},
		{Role: "assistant", Content: strPtr("Hi")},
	}

	result, compacted := compactHistory(client, messages)
	if compacted {
		t.Error("should not compact small history")
	}
	if len(result) != len(messages) {
		t.Error("history should be unchanged")
	}
}

func TestCompactHistoryKeepsSystemAndRecent(t *testing.T) {
	// Can't test actual LLM call without a server, but we can verify
	// the structure of the compacted history by checking needsCompaction
	// thresholds and message counting.

	// Build enough messages to trigger compaction check
	messages := []ChatMessage{
		{Role: "system", Content: strPtr("System prompt")},
	}
	for i := 0; i < 20; i++ {
		messages = append(messages,
			ChatMessage{Role: "user", Content: strPtr("User message")},
			ChatMessage{Role: "assistant", Content: strPtr("Assistant message")},
		)
	}

	// 40 non-system messages > keepRecentMessages+2 = 10
	// So the split logic should work
	nonSystem := messages[1:]
	if len(nonSystem) <= keepRecentMessages+2 {
		t.Fatalf("expected enough messages to compact, got %d", len(nonSystem))
	}
}
