<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class JobFile extends Model
{
    protected $fillable = [
        'fence_job_id', 'folder', 'filename', 'content_type',
        'size_bytes', 'storage_path', 'uploaded_by',
    ];

    public function job(): BelongsTo
    {
        return $this->belongsTo(FenceJob::class, 'fence_job_id');
    }

    public function uploader(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'uploaded_by');
    }
}
