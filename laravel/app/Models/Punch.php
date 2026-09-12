<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One shift.
 *
 * Paid time is the clock_in -> clock_out span, PLUS shop/load time, MINUS the
 * unpaid lunch. This is the only place that sum is written: the timesheet, the
 * CSV export, job costing and the payroll push all read it from here, so they
 * cannot disagree about what somebody is owed.
 */
class Punch extends Model
{
    use HasFactory;

    public const COST_CODES = [
        'install', 'tear_out', 'travel', 'shop', 'warranty_callback',
    ];

    protected $fillable = [
        'employee_id', 'fence_job_id', 'cost_code', 'clock_in', 'clock_out',
        'shop_minutes', 'lunch_minutes', 'km_tenths', 'work_done',
        'missed_reason', 'note', 'clock_in_lat', 'clock_in_lng',
        'geofence_metres', 'edited',
    ];

    protected function casts(): array
    {
        return [
            'clock_in' => 'datetime',
            'clock_out' => 'datetime',
            'shop_minutes' => 'integer',
            'lunch_minutes' => 'integer',
            'km_tenths' => 'integer',
            'edited' => 'boolean',
        ];
    }

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }

    public function job(): BelongsTo
    {
        return $this->belongsTo(FenceJob::class, 'fence_job_id');
    }

    public function jobSnapshots(): HasMany
    {
        return $this->hasMany(PunchJobSnapshot::class);
    }

    /**
     * Paid minutes. Null while the punch is still open — an unfinished shift
     * has no payable length yet, which is different from a zero-length one.
     * Never negative: a lunch longer than the shift is rejected on the way in,
     * and this floors at zero so a bad import can't pay negative time.
     */
    public function paidMinutes(): ?int
    {
        if (! $this->clock_out) {
            return null;
        }

        $span = $this->clock_in->diffInMinutes($this->clock_out);

        return max(0, $span + $this->shop_minutes - $this->lunch_minutes);
    }

    /** Paid hours, rounded to 2dp for display and payroll. */
    public function paidHours(): ?float
    {
        $minutes = $this->paidMinutes();

        return $minutes === null ? null : round($minutes / 60, 2);
    }

    /** Kilometres as entered by the driver, or null when none were given. */
    public function km(): ?float
    {
        return $this->km_tenths === null ? null : $this->km_tenths / 10;
    }

    public function isOpen(): bool
    {
        return $this->clock_out === null;
    }
}
