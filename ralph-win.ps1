# Ralph-Win: Claude Code Autonomous Loop for Windows
# Scoped to Bela Belux Project

param (
    [int]$MaxLoops = 50,
    [string]$PromptFile = ".ralph/PROMPT.md",
    [string]$FixPlanFile = ".ralph/fix_plan.md",
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# Setup Paths
$RalphDir = ".ralph"
$LogDir = "$RalphDir/logs"
$LogFile = "$LogDir/ralph-win.log"

if (-not (Test-Path $RalphDir)) {
    Write-Error "Directory .ralph not found. Run initialize first."
}

if (-not (Test-Path $PromptFile)) {
    Write-Error "Prompt file $PromptFile not found."
}

function Write-Log ($Message, $Level = "INFO") {
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $FormattedMessage = "[$Timestamp] [$Level] $Message"
    Write-Host $FormattedMessage
    Add-Content -Path $LogFile -Value $FormattedMessage
}

Write-Log "Starting Ralph-Win Loop..."

$LoopCount = 1
$ExitSignal = $false

while ($LoopCount -le $MaxLoops -and -not $ExitSignal) {
    Write-Log "--- Loop $LoopCount ---" "LOOP"
    
    # Read Instructions
    $PromptContent = Get-Content $PromptFile -Raw
    
    # Load custom context from fix_plan.md if available
    $FixPlan = ""
    if (Test-Path $FixPlanFile) {
        $FixPlan = Get-Content $FixPlanFile -Raw
        $PromptContent += "`n`n## Current Fix Plan Status:`n$FixPlan"
    }

    Write-Log "Sending instructions to Claude Code..."
    
    # Execute Claude Code
    # We use --non-interactive to avoid hanging
    # We use --output-format json to facilitate parsing (though we'll look for the status block in text fallback)
    try {
        # Note: We pass the prompt as the first argument
        # We use Start-Process or just direct call if we want to stream
        $ClaudeOutput = & claude --print $PromptContent 2>&1 | Out-String
        
        # Save output for debugging
        $ClaudeOutput | Out-File "$LogDir/loop_$LoopCount.raw.log"
        
        # Parse Status Block
        if ($ClaudeOutput -match "(?s)---RALPH_STATUS---(.*?)---END_RALPH_STATUS---") {
            $StatusBlock = $Matches[1]
            Write-Log "Status Block Found:"
            
            # Simple line parsing for status
            if ($StatusBlock -match "STATUS:\s*(\w+)") { Write-Log "  Status: $($Matches[1])" }
            if ($StatusBlock -match "EXIT_SIGNAL:\s*(true|false)") { 
                $ExitSignal = ($Matches[1] -eq "true")
                Write-Log "  Exit Signal: $ExitSignal"
            }
            if ($StatusBlock -match "RECOMMENDATION:\s*(.*)") { Write-Log "  Rec: $($Matches[1])" }
        } else {
            Write-Log "Warning: No RALPH_STATUS block found in Claude output." "WARN"
        }

    } catch {
        Write-Log "Error executing Claude: $($_.Exception.Message)" "ERROR"
        break
    }

    if ($ExitSignal) {
        Write-Log "Exit signal received. Project complete or stopped requested." "SUCCESS"
        break
    }

    $LoopCount++
    if ($LoopCount -le $MaxLoops) {
        Write-Log "Waiting 5 seconds before next loop..."
        Start-Sleep -Seconds 5
    }
}

Write-Log "Ralph-Win finished."
