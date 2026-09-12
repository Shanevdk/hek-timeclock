<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class EmployeePermission extends Model
{
    protected $fillable = ['employee_id', 'permission'];

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }
}
