package scenario

import (
	"fmt"
	"log"
)

// Logger is a thin structured wrapper over the standard library logger.
// It gives the scenario a consistent, greppable output format:
//
//	== PHASE ==      a lettered phase boundary
//	-> step          an individual API call
//	   ok / skip     the outcome of a step
//
// It deliberately avoids any third-party logging dependency: net/http and
// the standard library are the only runtime requirements of this demo.
type Logger struct {
	l *log.Logger
}

// NewLogger builds a Logger writing through the given standard logger.
func NewLogger(l *log.Logger) *Logger {
	return &Logger{l: l}
}

// Phase prints a phase boundary (A bootstrap, B catalogue, ...).
func (lg *Logger) Phase(name string) {
	lg.l.Printf("\n== %s ==", name)
}

// Step prints the start of an individual API operation.
func (lg *Logger) Step(format string, args ...any) {
	lg.l.Printf("-> %s", fmt.Sprintf(format, args...))
}

// OK prints the successful outcome of the preceding step.
func (lg *Logger) OK(format string, args ...any) {
	lg.l.Printf("   ok  %s", fmt.Sprintf(format, args...))
}

// Skip prints a tolerated skip (plan-gated, optional, sandbox-only).
func (lg *Logger) Skip(format string, args ...any) {
	lg.l.Printf("   skip %s", fmt.Sprintf(format, args...))
}

// Warnf prints a non-fatal warning.
func (lg *Logger) Warnf(format string, args ...any) {
	lg.l.Printf("   warn %s", fmt.Sprintf(format, args...))
}

// Errorf prints a fatal error line.
func (lg *Logger) Errorf(format string, args ...any) {
	lg.l.Printf("   ERR %s", fmt.Sprintf(format, args...))
}

// Infof prints a free-form informational line.
func (lg *Logger) Infof(format string, args ...any) {
	lg.l.Printf("   %s", fmt.Sprintf(format, args...))
}
