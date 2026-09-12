<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A booked piece of work at an address, possibly running over several days.
 */
class FenceJob extends Model
{
    use HasFactory;

    protected $fillable = [
        'address', 'description', 'starts_on', 'ends_on', 'start_time',
        'due_on', 'job_type', 'notes_driver', 'notes_internal', 'confirmed',
        'lat', 'lng',
    ];

    protected function casts(): array
    {
        return [
            'starts_on' => 'date',
            'ends_on' => 'date',
            'due_on' => 'date',
            'confirmed' => 'boolean',
        ];
    }

    public function crew(): BelongsToMany
    {
        return $this->belongsToMany(Employee::class)->withTimestamps();
    }

    public function punches(): HasMany
    {
        return $this->hasMany(Punch::class);
    }

    public function files(): HasMany
    {
        return $this->hasMany(JobFile::class);
    }

    public function folders(): HasMany
    {
        return $this->hasMany(JobFolder::class);
    }

    /** Last day of the run — the start day for an ordinary one-day job. */
    public function lastDay(): ?string
    {
        return $this->ends_on?->toDateString() ?? $this->starts_on?->toDateString();
    }

    /** How many days the run covers, inclusive. */
    public function dayCount(): int
    {
        if (! $this->starts_on) {
            return 0;
        }

        return $this->ends_on
            ? $this->starts_on->diffInDays($this->ends_on) + 1
            : 1;
    }

    /**
     * Jobs live on a given day — a multi-day run counts on every day it covers,
     * not just the day it started, which is what lets a crew tag it at
     * clock-out on day two.
     */
    public function scopeCoveringDay(Builder $query, string $day): Builder
    {
        return $query->where(function (Builder $q) use ($day) {
            $q->where('starts_on', $day)
                ->orWhere(fn (Builder $r) => $r
                    ->where('starts_on', '<=', $day)
                    ->where('ends_on', '>=', $day));
        });
    }
}
