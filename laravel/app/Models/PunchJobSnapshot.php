<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * The job a crew member tagged at clock-out, with its address copied onto the
 * row: a timesheet has to still read correctly after the job it pointed at is
 * edited or deleted.
 */
class PunchJobSnapshot extends Model
{
    protected $fillable = [
        'punch_id', 'fence_job_id', 'address', 'description', 'lat', 'lng',
    ];

    public function punch(): BelongsTo
    {
        return $this->belongsTo(Punch::class);
    }

    public function job(): BelongsTo
    {
        return $this->belongsTo(FenceJob::class, 'fence_job_id');
    }
}
