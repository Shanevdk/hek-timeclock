<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class JobFolder extends Model
{
    protected $fillable = ['fence_job_id', 'path'];

    public function job(): BelongsTo
    {
        return $this->belongsTo(FenceJob::class, 'fence_job_id');
    }
}
