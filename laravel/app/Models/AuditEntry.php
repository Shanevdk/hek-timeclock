<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\MorphTo;

/**
 * Append-only. Nothing in the app updates or deletes an audit row.
 */
class AuditEntry extends Model
{
    protected $table = 'audit_log';
    public $timestamps = false;

    protected $fillable = [
        'auditable_type', 'auditable_id', 'employee_id', 'action',
        'field', 'old_value', 'new_value', 'ip_address',
    ];

    protected function casts(): array
    {
        return ['old_value' => 'array', 'new_value' => 'array'];
    }

    public function auditable(): MorphTo
    {
        return $this->morphTo();
    }

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }
}
